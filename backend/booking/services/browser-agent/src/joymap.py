"""JoyMap 享樂地圖的訂位頁專用程式(2026-11 實測 https://www.joymap.tw/store/jump888)。

流程：店家頁(/store/<slug>)選人數、日期、時段 → 訂位頁(/booking?slug=<slug>)填資料 → 「確認訂位」。
LLM 只負責店家頁的點選；訂位頁的欄位由這裡的程式填寫、回讀，並在送出前與已確認方案逐項比對。
"""
import asyncio
import json
import re

TITLES = ("先生", "小姐")
PURPOSES = ("朋友聚餐", "家庭聚會", "商務聚餐", "慶祝生日", "浪漫約會", "其他目的")
NOTES_MAX = 50  # 訂位頁備註欄的上限(頁面顯示 0/50)

SELECTORS = {
    "name": "input#name",
    "email": 'input[placeholder="請輸入您的電子郵件"]',
    "tel": 'input[type=tel][placeholder="請輸入您的手機號碼"]',
    "notes": "textarea",
}

STATE_JS = """() => {
  const q = (s) => document.querySelector(s);
  const v = (s) => (q(s) || {}).value ?? null;
  const name = q('%(name)s');
  const select = name ? name.parentElement.querySelector('select') : null;
  const purpose = [...document.querySelectorAll('.purpose-options input[type=radio]')].filter(r => r.checked).map(r => r.id);
  const agree = q('input[type=checkbox][role=checkbox]');
  const text = document.body.innerText || '';
  const summary = (text.split('訂位日期')[1] || '').split('真實姓名')[0];
  // 欄位錯誤提示：Vuetify / 自訂表單常見的錯誤 class，只取看得到的文字。
  const errors = [...document.querySelectorAll('.error--text, .v-messages__message, .error-message, .error, .invalid-feedback')]
    .filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 5);
  return JSON.stringify({
    on_form: location.pathname.startsWith('/booking') && !!name,
    path: location.pathname,
    name: name ? name.value : null,
    title: select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].text.trim() : null,
    email: v('%(email)s'), tel: v('%(tel)s'), notes: v('%(notes)s'),
    purpose, agree: agree ? agree.getAttribute('aria-checked') === 'true' || agree.checked : null,
    summary: summary.replace(/\\s+/g, ' ').trim().slice(0, 200), errors,
  });
}""" % SELECTORS

SET_TITLE_JS = """(title) => {
  const name = document.querySelector('%(name)s');
  const select = name && name.parentElement.querySelector('select');
  if (!select) return 'missing';
  const option = [...select.options].find(o => o.text.trim() === title);
  if (!option) return 'no-option';
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
}""" % SELECTORS

MARK_SUBMIT_JS = """() => {
  if (!location.pathname.startsWith('/booking')) return 0;
  const buttons = [...document.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '確認訂位');
  buttons.forEach(b => b.setAttribute('data-heph-submit', '1'));
  return buttons.length;
}"""

# 2026-11 第一筆真實訂位實測：按下「確認訂位」→ POST https://api.joymap.tw/order 回
#   {"code":1,"msg":"成功","return":{"order_no":"BK-0571511",...}}
# → 頁面導向 /reservation-success，顯示「感謝您，您已成功訂位！」。
# 判斷以 API 回應為主(有訂位編號)，結果頁為輔。
ORDER_API = "https://api.joymap.tw/order"
SUCCESS_PATH = "/reservation-success"
SUCCESS_TEXTS = ("已成功訂位", "訂位完成")
ERROR_TEXTS = ("訂位失敗", "已額滿", "無法訂位", "發生錯誤")


async def form_state(page) -> dict:
    raw = await page.evaluate(STATE_JS)
    return json.loads(raw) if isinstance(raw, str) else raw


async def _single(page, selector: str):
    elements = await page.get_elements_by_css_selector(selector)
    return elements[0] if elements else None


def summary_problems(state: dict, data) -> list[str]:
    """訂位頁上方的摘要(日期 / 時間 / 人數)是否等於已確認方案。"""
    summary = state.get("summary") or ""
    year, month, day = (int(part) for part in data.date.split("-"))
    problems = []
    found = re.search(r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日", summary)
    if not found or tuple(int(x) for x in found.groups()) != (year, month, day):
        problems.append("日期")
    found = re.search(r"訂位時間\s*(\d{1,2}):(\d{2})", summary)
    hour, minute = (int(part) for part in data.time.split(":"))
    if not found or (int(found.group(1)), int(found.group(2))) != (hour, minute):
        problems.append("時段")
    found = re.search(r"訂位人數\s*(\d+)\s*人\s*\(含\s*(\d+)\s*位兒童\)", summary)
    # 方案只有總人數；一律訂成人、兒童 0。
    if not found or int(found.group(1)) != data.party_size or int(found.group(2)) != 0:
        problems.append("人數")
    return problems


def problems(state: dict, data) -> list[str]:
    """把頁面回讀的狀態和已確認方案逐項比對；空清單代表完全一致。"""
    if not state.get("on_form"):
        return ["不在訂位資料頁"]
    out = summary_problems(state, data)
    extra = data.extra or {}
    if state.get("name") != data.contact.name:
        out.append("姓名")
    if state.get("title") != extra.get("title"):
        out.append("稱謂")
    if (state.get("email") or "").strip() != data.contact.email:
        out.append("電子郵件")
    if "".join(ch for ch in (state.get("tel") or "") if ch.isdigit()) != data.contact.phone:
        out.append("手機號碼")
    if state.get("purpose") != [extra.get("purpose")]:
        out.append("用餐目的")
    if (state.get("notes") or "") != (data.notes or ""):
        out.append("訂位備註")
    if state.get("agree") is not True:
        out.append("未勾選同意條款")
    if state.get("errors"):
        out.append("頁面顯示欄位錯誤：" + "；".join(state["errors"]))
    return out


def plan_problems(data) -> list[str]:
    """送出前就能判斷、頁面一定填不進去的方案內容。"""
    extra = data.extra or {}
    out = []
    if extra.get("title") not in TITLES:
        out.append("稱謂")
    if extra.get("purpose") not in PURPOSES:
        out.append("用餐目的")
    if data.notes and len(data.notes) > NOTES_MAX:
        out.append(f"備註超過 {NOTES_MAX} 字")
    return out


async def fill(session, data) -> tuple[bool, str]:
    """以程式填寫訂位頁並逐欄回讀驗證。值只來自 confirmed plan。"""
    page = await session.must_get_current_page()
    state = await form_state(page)
    if not state.get("on_form"):
        return False, "還沒進入訂位資料頁(網址 /booking)。請先在店家頁選好人數、日期，再點已確認的時段。"
    bad_plan = plan_problems(data)
    if bad_plan:
        return False, "已確認方案的" + "、".join(bad_plan) + "無法填入此頁。請以 done 回傳 kind=rejected、code=PLAN_INVALID。"
    slot = summary_problems(state, data)
    if slot:
        return False, (
            f"訂位頁上方的{'、'.join(slot)}與已確認方案不符(頁面顯示：{state.get('summary')})。"
            "請點「修改」回到店家頁重新選擇；如果選不到，以 done 回傳 kind=rejected、code=SLOT_UNAVAILABLE。"
        )
    extra = data.extra or {}
    for key, value in (("name", data.contact.name), ("email", data.contact.email), ("tel", data.contact.phone)):
        element = await _single(page, SELECTORS[key])
        if element is None:
            return False, f"找不到欄位 {key}"
        await element.fill(value, clear=True)
        await asyncio.sleep(0.2)
    notes = await _single(page, SELECTORS["notes"])
    if notes is not None and (data.notes or (state.get("notes") or "")):
        await notes.fill(data.notes or "", clear=True)
    if await page.evaluate(SET_TITLE_JS, extra["title"]) != "ok":
        return False, "找不到稱謂選單"
    purpose = await _single(page, f'.purpose-options label[for="{extra["purpose"]}"]')
    if purpose is None:
        return False, "找不到用餐目的選項"
    await purpose.click()
    await asyncio.sleep(0.3)
    state = await form_state(page)
    if state.get("agree") is not True:
        agree = await _single(page, "input[type=checkbox][role=checkbox]")
        if agree is None:
            return False, "找不到同意條款勾選框"
        await agree.click()
        await asyncio.sleep(0.3)
    found = problems(await form_state(page), data)
    if found:
        return False, "表單回讀不符：" + "、".join(found) + "。請再呼叫一次 fill_contact_form。"
    return True, "訂位資料已由程式填好並逐欄驗證通過(日期、時段、人數、姓名、稱謂、電子郵件、手機、用餐目的、備註、同意條款)。"


def parse_order(body: str | None) -> tuple[str, str | None, str | None]:
    """解析 POST /order 的回應。回傳 (ok|fail|unknown, 訂位編號, 訊息)。"""
    try:
        payload = json.loads(body or "")
    except ValueError:
        return "unknown", None, None
    if not isinstance(payload, dict):
        return "unknown", None, None
    message = payload.get("msg") if isinstance(payload.get("msg"), str) else None
    order_no = (payload.get("return") or {}).get("order_no") if isinstance(payload.get("return"), dict) else None
    if payload.get("code") == 1 and isinstance(order_no, str) and order_no:
        return "ok", order_no, message
    if "code" in payload and payload.get("code") != 1:
        return "fail", None, message
    return "unknown", None, message


async def await_outcome(page, order_response) -> tuple[str, str, str | None]:
    """按下「確認訂位」後最多等 20 秒。

    order_response: async () -> 回應 body | None，由呼叫端從網路記錄取得 POST /order 的回應。
    回傳 (success|error|unknown, 證據, 訂位編號)。
    """
    for _ in range(20):
        await asyncio.sleep(1)
        kind, order_no, message = parse_order(await order_response())
        if kind == "ok":
            return "success", f"JoyMap 訂位 API 回應成功({message or 'code=1'})", order_no
        if kind == "fail":
            return "error", f"JoyMap 訂位 API 回應失敗：{message or '未提供原因'}", None
        try:
            path = str(await page.evaluate("() => location.pathname"))
            text = str(await page.evaluate("() => (document.body.innerText || '').slice(0, 3000)"))
        except Exception:
            continue
        hit = next((t for t in SUCCESS_TEXTS if t in text), None)
        if path.startswith(SUCCESS_PATH) and hit:
            # 結果頁已出現但還沒讀到 API 回應：再給 API 一點時間以取得訂位編號
            await asyncio.sleep(1)
            kind, order_no, _message = parse_order(await order_response())
            return "success", f"結果頁 {SUCCESS_PATH} 顯示「{hit}」", order_no if kind == "ok" else None
        hit = next((t for t in ERROR_TEXTS if t in text), None)
        if hit and path.startswith("/booking"):  # 還停在表單且出現錯誤字樣：被頁面拒絕
            return "error", f"頁面出現「{hit}」", None
    return "unknown", "", None


def task(data, dry_run: bool) -> str:
    """店家頁的操作說明。聯絡資料不放進 prompt：由 fill_contact_form 以程式填寫。"""
    _year, month, day = (int(part) for part in data.date.split("-"))
    final_step = (
        "fill_contact_form 驗證通過後不要送出，直接以 done 回傳 kind=rejected、code=DRY_RUN_READY、stage=pre_submit。"
        if dry_run
        else "fill_contact_form 驗證通過後，不要點任何東西，立刻呼叫 submit_reservation(只呼叫一次)。它會再核對一次、按下「確認訂位」並回報結果；依它的回報決定 done 的內容。你不能自己點「確認訂位」，點了也會被擋下。"
    )
    return f"""你是餐廳訂位執行助手。網址：{data.url}
餐廳就是這個網址打開的那一間(網址已由系統驗證)。只可訂這筆已經由使用者確認的方案，絕不改動：
- 人數：成人 {data.party_size} 位、兒童 0 位
- 日期：{data.date}({month} 月 {day} 日)
- 時段：{data.time}

頁面說明(享樂地圖 JoyMap，已實測)：
- 店家頁右側有「成人」「兒童」人數(左右的 − / + 按鈕調整)、月曆(預設只顯示一週，「顯示整月」可展開，月份旁的箭頭切換月份)、「選擇時段」按鈕(例如 20:30)。灰色的日期不能訂。
- 點時段按鈕會進入訂位資料頁(網址 /booking)，上方顯示訂位日期、時間、人數，下面是聯絡資料、用餐目的、備註、同意條款，最下方「確認訂位」是最終送出(只能透過 submit_reservation)。
- 不要登入、不要點頁面上方的「訂位」分頁或其他連結。

每一步都有畫面截圖，直接看截圖判斷狀態。步驟：
1. 在店家頁把「成人」調成 {data.party_size}、「兒童」保持 0。
2. 在月曆點 {month} 月 {day} 日(不在目前顯示的範圍就先點「顯示整月」或切換月份)。
3. 點時段按鈕「{data.time}」，進入訂位資料頁。
4. 呼叫 fill_contact_form。它會以程式填好所有欄位並逐欄驗證，你不需要也不能自己輸入文字。回報不符時依它的說明處理；連續兩次失敗就以 done 回傳 kind=rejected、code=FORM_FILL_FAILED。
5. {final_step}

異常處理：
- 該日期是灰色、或沒有「{data.time}」這個時段：以 done 回傳 kind=rejected、code=SLOT_UNAVAILABLE，message 說明看到什麼。
- 遇到付款、訂金、信用卡、CAPTCHA、OTP、要求登入：不要繞過，回傳 kind=rejected 並填 code。

結果：
- submit_reservation 回報成功時 kind=success，confirmation_no 填它提供的編號(沒有就填「JoyMap 已訂位」)，evidence 列成功畫面上看得到的短句。
- 頁面明確拒絕時 kind=rejected，填 code 與 message。
- 按過「確認訂位」但無法判斷結果時 kind=ambiguous，填 stage 與 message。"""
