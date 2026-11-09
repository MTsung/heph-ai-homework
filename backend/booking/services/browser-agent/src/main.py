"""已確認訂位方案的 browser-use agent。

此服務不找餐廳、不猜測或改寫方案。booking service 先完成資料收集與使用者確認，
agent 才取得不可變的 confirmed_plan 與 URL。目前只接受 BROWSER_BOOKING_URL 這一個享樂地圖(JoyMap)店家頁；
訂位頁的欄位填寫、核對與送出由 joymap.py 的程式處理，LLM 只負責在店家頁選人數、日期、時段。
"""
import asyncio
import base64
import binascii
import hmac
import inspect as pyinspect
import json
import logging
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4
from typing import Literal

from browser_use import ActionResult, Agent, BrowserSession, ChatGoogle, Tools
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

import joymap

PORT = int(os.getenv("PORT", "3010"))
INTERNAL_TOKEN = os.getenv("INTERNAL_TOKEN", "dev-internal-token-change-me")
TARGET_URL = os.getenv("BROWSER_BOOKING_URL", "https://www.joymap.tw/store/jump888")
MODEL = os.getenv("BROWSER_AGENT_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.5-flash"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
SUBMIT_ENABLED = os.getenv("BROWSER_AGENT_SUBMIT_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
MAX_STEPS = int(os.getenv("BROWSER_AGENT_MAX_STEPS", "45"))
TRACE_ENABLED = os.getenv("BROWSER_AGENT_TRACE_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
ARTIFACT_DIR = Path(os.getenv("BROWSER_AGENT_ARTIFACT_DIR", "/var/lib/browser-agent/artifacts"))
# 單次 agent 執行的時間上限；submit 在「確定沒按過最終訂位」時最多重跑一次，總時間需小於 booking 端的 HTTP 逾時。
ATTEMPT_TIMEOUT_SEC = int(os.getenv("BROWSER_AGENT_ATTEMPT_TIMEOUT_SEC", "270"))
SUBMIT_BUDGET_SEC = int(os.getenv("BROWSER_AGENT_SUBMIT_BUDGET_SEC", "560"))
# submit 只開放點選需要的動作。實測過的問題：send_keys 的 Escape 會關閉對話框並清空欄位；
# search_page / evaluate / find_elements 讓 agent 原地查詢而不前進；evaluate 也能執行任意 JS，不該開放。
# 欄位由 fill_contact_form(程式)填寫，因此不開放 input：LLM 打錯欄位的路徑直接消失。
# navigate 必須保留：directly_open_url 以它作為開啟訂位網址的初始動作。
SUBMIT_ALLOWED_ACTIONS = {"navigate", "click", "scroll", "wait", "select_dropdown", "dropdown_options", "done"}
# 判斷一次點擊「可能是最終送出」的文字片段。寧可多判(LLM 該點的按鈕都不含這些字)，
# 不可少判(少判會讓已送出的訂位被當成沒送出而重跑，造成重複訂位)。
SUBMIT_HINTS = ("訂位", "預訂", "確認", "送出", "完成", "book", "reserve", "submit", "confirm")
SAFE_CLICK_LABELS: set[str] = set()

app = FastAPI(title="browser-agent", docs_url=None, redoc_url=None)
# browser-use 預設會記錄 task / agent memory；submit task 含個資，所以 production 只留 warning 以上。
logging.getLogger("browser_use").setLevel(logging.WARNING)


class Contact(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    # booking service 已正規化為國內十碼；JoyMap 手機欄位要求台灣手機。
    phone: str = Field(pattern=r"^09\d{8}$")
    email: str = Field(min_length=3, max_length=80)


class SubmitRequest(BaseModel):
    url: str
    booking_id: str
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    party_size: int = Field(ge=1, le=8)
    contact: Contact
    # 店家表單的額外必填欄位(booking 端以 extraFields 向使用者詢問)：title=先生/小姐、purpose=用餐目的
    extra: dict[str, str] = Field(default_factory=dict)
    notes: str | None = Field(default=None, max_length=200)


class BrowserTrace(BaseModel):
    enabled: bool
    run_id: str | None = None
    manifest: str | None = None
    screenshot_count: int = 0
    step_count: int = 0
    started_at: str | None = None
    finished_at: str | None = None


class SubmitResult(BaseModel):
    kind: Literal["success", "rejected", "ambiguous"]
    confirmation_no: str | None = None
    code: str | None = None
    message: str | None = None
    stage: str | None = None
    evidence: list[str] = Field(default_factory=list)
    trace: BrowserTrace | None = None


def require_token(token: str | None) -> None:
    if not token or not hmac.compare_digest(token, INTERNAL_TOKEN):
        raise HTTPException(status_code=401, detail="internal token invalid")


def require_target(url: str) -> None:
    # 刻意只支援一個取得授權的店家連結。
    if url.split("?", 1)[0].rstrip("/") != TARGET_URL.split("?", 1)[0].rstrip("/"):
        raise HTTPException(status_code=400, detail="unsupported booking URL")


def llm() -> ChatGoogle:
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="browser agent needs GEMINI_API_KEY")
    # use_thinking + 結構化輸出在 3000 tokens 時曾被截斷(ModelOutputTruncatedError)。
    return ChatGoogle(model=MODEL, api_key=GEMINI_API_KEY, max_output_tokens=8000)


def browser() -> BrowserSession:
    # URL 入口由 require_target 固定；頁面內跳轉(店家頁 → /booking)不限制。
    return BrowserSession(
        executable_path="/usr/bin/chromium",
        is_local=True,
        use_cloud=False,
        chromium_sandbox=False,
        enable_default_extensions=False,
        cross_origin_iframes=False,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
        headless=True,
        viewport={"width": 1440, "height": 1000},
        minimum_wait_page_load_time=0.8,
        wait_between_actions=0.5,
        keep_alive=False,
    )


class TraceWriter:
    """將開發期的 browser-use 步驟安全寫入僅本機可讀的 artifact volume。"""

    def __init__(self, booking_id: str):
        self.enabled = TRACE_ENABLED
        self.booking_id = booking_id
        self.run_id = str(uuid4())
        self.relative = Path("bookings") / booking_id / self.run_id
        self.target = ARTIFACT_DIR / self.relative
        self.shots_dir = self.target / "screenshots"
        self.started_at = datetime.now(UTC).isoformat()
        self.finished_at: str | None = None
        self.status = "running"
        self.error_class: str | None = None
        self.steps: dict[int, dict[str, object]] = {}
        self.screenshots: dict[int, str] = {}
        # 同一個 run 內 agent 可能重跑；browser-use 每次都從 step 1 起算，因此以 offset 讓序號連續不覆蓋。
        self.offset = 0
        self.network: str | None = None
        self.available = False
        if not self.enabled:
            return
        try:
            # admin 唯讀掛載相同 volume，需讓其容器帳號可穿越與讀取；服務仍僅綁定本機 127.0.0.1。
            self.target.mkdir(parents=True, exist_ok=True, mode=0o755)
            self.shots_dir.mkdir(exist_ok=True, mode=0o755)
            self.target.chmod(0o755)
            self.shots_dir.chmod(0o755)
            self.available = True
            self._write_manifest()
        except OSError:
            # 觀測資料不能阻斷訂位。volume 無法寫入時，回傳 disabled trace 而非誤導後台。
            self.available = False

    def trace(self) -> BrowserTrace:
        if not self.enabled or not self.available:
            return BrowserTrace(enabled=False)
        return BrowserTrace(
            enabled=True,
            run_id=self.run_id,
            manifest=str(self.relative / "manifest.json"),
            screenshot_count=len(self.screenshots),
            step_count=len(self.steps),
            started_at=self.started_at,
            finished_at=self.finished_at,
        )

    def _write_admin_readable(self, path: Path, content: bytes) -> None:
        """以原子替換寫檔，讓只讀掛載的本機 admin 可以顯示 trace。"""
        temporary = path.with_suffix(f"{path.suffix}.tmp")
        with open(temporary, "wb") as handle:
            os.chmod(temporary, 0o644)
            handle.write(content)
        os.replace(temporary, path)

    def _manifest(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "booking_id": self.booking_id,
            "run_id": self.run_id,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "status": self.status,
            "error_class": self.error_class,
            "network": self.network,
            "screenshots": [
                {"sequence": sequence, "path": path}
                for sequence, path in sorted(self.screenshots.items())
            ],
            "steps": [self.steps[sequence] for sequence in sorted(self.steps)],
        }

    def _write_manifest(self) -> None:
        if not self.available:
            return
        try:
            payload = json.dumps(self._manifest(), ensure_ascii=False, indent=2).encode("utf-8")
            self._write_admin_readable(self.target / "manifest.json", payload)
        except OSError:
            # 已建立的截圖保留在 volume；但不要讓 trace I/O 改變 agent 的訂位行為。
            self.available = False

    @staticmethod
    def _action_name(output) -> str | None:
        actions = getattr(output, "action", None)
        if not isinstance(actions, list) or not actions:
            return None
        first = actions[0]
        try:
            value = first.model_dump(exclude_none=True, mode="json")
        except (AttributeError, TypeError, ValueError):
            return None
        return next(iter(value), None) if isinstance(value, dict) else None

    def write_network(self, payload: dict) -> None:
        """送出前後的網路請求(已遮蔽個資)寫到 run 目錄的 network.json，並在 manifest 標示。"""
        if not self.available:
            return
        try:
            self._write_admin_readable(self.target / "network.json", json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
            self.network = "network.json"
            self._write_manifest()
        except OSError:
            pass

    def begin_attempt(self) -> None:
        self.offset = max(self.steps, default=0)

    async def capture_step(self, state, output, step_number: int) -> None:
        """browser-use 每次決定 action 前呼叫；先寫圖片，再公開 manifest 中的路徑。"""
        if not self.available or step_number < 1:
            return
        sequence = self.offset + step_number
        screenshot_path: str | None = None
        raw = getattr(state, "screenshot", None)
        encoded = raw.split(",", 1)[-1] if isinstance(raw, str) else ""
        if encoded:
            try:
                png = base64.b64decode(encoded, validate=True)
                screenshot_path = f"screenshots/{sequence:04d}.png"
                self._write_admin_readable(self.shots_dir / f"{sequence:04d}.png", png)
                self.screenshots[sequence] = screenshot_path
            except (OSError, ValueError, binascii.Error):
                # 壞截圖不阻斷 agent，manifest 會如實標示該步沒有圖片。
                screenshot_path = None
        self.steps[sequence] = {
            "sequence": sequence,
            "action": self._action_name(output),
            "url": safe_url(getattr(state, "url", "")),
            # 只記點擊目標的按鈕文字；input 的內容是個資，不寫進 manifest。
            "target": click_targets(state, output) or None,
            "submit_controls": visible_submit_labels(state) or None,
            # agent 這一步「拿得到索引」的輸入欄位名稱(不含值)。欄位看得到卻不在這裡，代表 DOM 擷取漏掉了它。
            "fields": visible_field_labels(state) or None,
            "error": "browser state error" if getattr(state, "state_error", None) else None,
            "screenshot": screenshot_path,
        }
        self._write_manifest()

    def finalize(self, status: str, error: Exception | None = None) -> None:
        if not self.available:
            return
        self.status = status
        self.error_class = type(error).__name__ if error else None
        self.finished_at = datetime.now(UTC).isoformat()
        self._write_manifest()


def _actions(output) -> list[tuple[str, dict]]:
    actions = getattr(output, "action", None)
    if not isinstance(actions, list):
        return []
    parsed: list[tuple[str, dict]] = []
    for action in actions:
        try:
            value = action.model_dump(exclude_none=True, mode="json")
        except (AttributeError, TypeError, ValueError):
            continue
        if isinstance(value, dict):
            for name, params in value.items():
                parsed.append((name, params if isinstance(params, dict) else {}))
    return parsed


def _element_label(node) -> str:
    """元素在畫面上的文字(按鈕文字或無障礙名稱)，不含 input 的值。"""
    text = ""
    try:
        text = node.get_all_children_text() or ""
    except Exception:
        text = ""
    if not text.strip():
        ax = getattr(node, "ax_node", None)
        text = getattr(ax, "name", None) or ""
    return " ".join(text.split())[:40]


def click_targets(state, output) -> list[str]:
    """這一步要點的元素文字。用座標點擊或找不到元素時回傳 <coordinate> / <unknown>。"""
    selector_map = getattr(getattr(state, "dom_state", None), "selector_map", None) or {}
    targets: list[str] = []
    for name, params in _actions(output):
        if name != "click":
            continue
        index = params.get("index")
        if index is None:
            targets.append("<coordinate>")
            continue
        node = selector_map.get(index)
        targets.append(_element_label(node) if node is not None else "<unknown>")
    return targets


def looks_like_submit(label: str) -> bool:
    if label in {"<coordinate>", "<unknown>"}:
        return True
    return label not in SAFE_CLICK_LABELS and any(hint in label.lower() for hint in SUBMIT_HINTS)


def visible_submit_labels(state) -> list[str]:
    """畫面上可點、且會被 SubmitGuard 視為送出的元素文字；寫進 trace 以確認判斷有作用。"""
    selector_map = getattr(getattr(state, "dom_state", None), "selector_map", None) or {}
    labels = {_element_label(node) for node in selector_map.values()}
    return sorted(label for label in labels if label and looks_like_submit(label))


def visible_field_labels(state) -> list[str]:
    selector_map = getattr(getattr(state, "dom_state", None), "selector_map", None) or {}
    labels: list[str] = []
    for node in selector_map.values():
        if (getattr(node, "tag_name", "") or "").lower() not in {"input", "textarea"}:
            continue
        ax = getattr(node, "ax_node", None)
        attrs = getattr(node, "attributes", None) or {}
        label = getattr(ax, "name", None) or attrs.get("aria-label") or attrs.get("type") or "input"
        labels.append(" ".join(str(label).split())[:30])
    return labels


class SubmitBlocked(RuntimeError):
    pass


class FillContactFormParams(BaseModel):
    # Gemini 的 function schema 不接受沒有欄位的物件，所以保留一個不影響行為的欄位；填寫的值一律來自已確認方案。
    on_booking_page: bool = Field(description="已進入訂位資料頁(網址 /booking)時填 true")


class SubmitReservationParams(BaseModel):
    form_verified: bool = Field(description="fill_contact_form 已回報驗證通過時填 true")


async def _single(page, selector: str):
    elements = await page.get_elements_by_css_selector(selector)
    return elements[0] if elements else None


NETWORK_EVENTS = (
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFailed",
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
)


class NetworkRecorder:
    """開發期除錯：記錄按下「確認訂位」前後的 XHR / fetch 與 console 錯誤，用來判斷送出結果與被拒原因。

    - cdp_use 的事件註冊每個 method 只有一個 handler，直接 register 會蓋掉 browser-use watchdog 的 handler，
      所以這裡串接在原 handler 之後，結束時還原。
    - 送出的 payload 含姓名、電話、email：寫檔前把這些值(含 URL 編碼形式)替換成 [REDACTED]。
    """

    BODY_LIMIT = 6000

    def __init__(self, session: BrowserSession, data: "SubmitRequest"):
        self.client = session.cdp_client
        self.requests: dict[str, dict] = {}
        self.console: list[dict] = []
        self.previous: dict[str, object] = {}
        from urllib.parse import quote, quote_plus

        subscriber = data.contact.phone[1:]
        raw = {
            data.contact.name, data.contact.email, data.contact.phone, subscriber, f"886{subscriber}",
            f"{subscriber[:3]} {subscriber[3:6]} {subscriber[6:]}", f"+886 {subscriber[:3]} {subscriber[3:6]} {subscriber[6:]}",
        }
        if data.notes:
            raw.add(data.notes)
        variants = {v for value in raw if value for v in (value, quote(value), quote_plus(value), json.dumps(value)[1:-1])}
        self.secrets = sorted(variants, key=len, reverse=True)

    def redact(self, text: str | None) -> str | None:
        if text is None:
            return None
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        return text[: self.BODY_LIMIT] + (f"…(+{len(text) - self.BODY_LIMIT} chars)" if len(text) > self.BODY_LIMIT else "")

    def start(self) -> None:
        handlers = self.client._event_registry._handlers  # 私有屬性：見 class docstring
        for method in NETWORK_EVENTS:
            previous = handlers.get(method)
            self.previous[method] = previous

            async def chained(params, session_id, _method=method, _previous=previous):
                if _previous is not None:
                    result = _previous(params, session_id)
                    if pyinspect.isawaitable(result):
                        await result
                try:
                    self._on_event(_method, params, session_id)
                except Exception:
                    pass  # 除錯記錄不能影響訂位流程

            self.client._event_registry.register(method, chained)

    def stop(self) -> None:
        for method, previous in self.previous.items():
            if previous is None:
                self.client._event_registry.unregister(method)
            else:
                self.client._event_registry.register(method, previous)

    def _on_event(self, method: str, params: dict, session_id: str | None) -> None:
        if method == "Network.requestWillBeSent":
            if params.get("type") not in {"XHR", "Fetch", "Document"}:
                return
            request = params.get("request", {})
            self.requests.setdefault(params["requestId"], {
                "ts": round(time.time(), 3),
                "type": params.get("type"),
                "method": request.get("method"),
                "url": self.redact(request.get("url", ""))[:500],
                "post_data": self.redact(request.get("postData")),
                "session_id": session_id,
            })
        elif method == "Network.responseReceived":
            entry = self.requests.get(params.get("requestId"))
            if entry is not None:
                response = params.get("response", {})
                entry["status"] = response.get("status")
                entry["mime"] = response.get("mimeType")
        elif method == "Network.loadingFailed":
            entry = self.requests.get(params.get("requestId"))
            if entry is not None:
                entry["failed"] = params.get("errorText")
                entry["blocked_reason"] = params.get("blockedReason")
        elif method == "Runtime.consoleAPICalled" and params.get("type") in {"error", "warning"}:
            args = [str(a.get("value", a.get("description", "")))[:300] for a in params.get("args", [])]
            self.console.append({"ts": round(time.time(), 3), "type": params.get("type"), "text": self.redact(" ".join(args))})
        elif method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails", {})
            text = details.get("text", "") + " " + str(details.get("exception", {}).get("description", ""))
            self.console.append({"ts": round(time.time(), 3), "type": "exception", "text": self.redact(text[:600])})

    async def response_body(self, url_prefix: str, method: str = "POST") -> str | None:
        """取得第一個符合的請求的原始回應 body(未遮蔽，只留在記憶體供程式判斷結果，不寫檔)。"""
        for request_id, entry in self.requests.items():
            if entry.get("method") != method or not entry.get("url", "").startswith(url_prefix) or "status" not in entry:
                continue
            if "_raw" in entry:
                return entry["_raw"]
            try:
                body = await self.client.send.Network.getResponseBody(params={"requestId": request_id}, session_id=entry["session_id"])
            except Exception:
                return None  # 回應可能還沒接收完，下一輪再試
            entry["_raw"] = None if body.get("base64Encoded") else body.get("body", "")
            return entry["_raw"]
        return None

    async def collect(self) -> dict:
        """取回 XHR / fetch 的回應內容(訂位 API 的錯誤代碼通常在回應 body 裡)。"""
        for request_id, entry in self.requests.items():
            if entry.get("type") not in {"XHR", "Fetch"} or "status" not in entry:
                continue
            try:
                body = await self.client.send.Network.getResponseBody(params={"requestId": request_id}, session_id=entry["session_id"])
                text = body.get("body", "")
                if body.get("base64Encoded"):
                    text = f"<base64 {len(text)} chars>"
                entry["response_body"] = self.redact(text)
            except Exception as exc:
                entry["response_body_error"] = type(exc).__name__
        return {
            "requests": [{k: v for k, v in e.items() if k not in {"session_id", "_raw"}} for e in self.requests.values()],
            "console": self.console,
        }


class SubmitGuard:
    """以程式把關最終「確認訂位」，不依賴 LLM 的自述。

    - LLM 的 click 只要目標像送出按鈕(或無法辨識目標)就擋下：browser-use 在執行 action 前呼叫 step callback，
      丟出例外就不會執行。實測 LLM 會用到過期的元素索引而點錯元素。
    - 唯一能按「確認訂位」的路徑是 submit_reservation → submit()：按下前重新回讀表單並與已確認方案逐項比對，
      一致才以 CSS 取得按鈕點擊(確認什麼才能送出什麼)。dry run 時一律拒絕。
    - maybe_submitted 在點擊「之前」設定(write-ahead)。從沒設定過 → 店家一定沒收到，可以安全地重跑或回報失敗。
    只開放 SUBMIT_ALLOWED_ACTIONS(沒有 send_keys Enter / evaluate / input)，所以沒有其他能送出表單的路徑。
    """

    def __init__(self, dry_run: bool, data: SubmitRequest):
        self.dry_run = dry_run
        self.data = data
        self.maybe_submitted = False
        self.success_seen: str | None = None
        self.error_seen: str | None = None
        self.confirmation_no: str | None = None
        self.network: dict | None = None

    async def check(self, state, output, session: BrowserSession) -> None:
        for target in click_targets(state, output):
            if looks_like_submit(target):
                raise SubmitBlocked(
                    f"已擋下點擊「{target}」：最終送出只能透過 submit_reservation。"
                    + ("dry run 不會送出；表單驗證通過後直接以 done 回傳 kind=rejected、code=DRY_RUN_READY、stage=pre_submit。" if self.dry_run else "")
                )

    async def submit(self, session: BrowserSession) -> tuple[bool, str]:
        if self.dry_run:
            return False, "dry run：不會按「確認訂位」。表單驗證通過時請以 done 回傳 kind=rejected、code=DRY_RUN_READY、stage=pre_submit。"
        if self.maybe_submitted:
            return False, "已經按過「確認訂位」，不可再按。請觀察畫面：看到成功字樣回傳 kind=success，否則回傳 kind=ambiguous。"
        page = await session.must_get_current_page()
        problems = joymap.problems(await joymap.form_state(page), self.data)
        if problems:
            return False, "沒有送出：表單與已確認方案不符(" + "、".join(problems) + ")。請再呼叫 fill_contact_form。"
        if await page.evaluate(joymap.MARK_SUBMIT_JS) in (0, "0"):
            return False, "沒有送出：找不到「確認訂位」按鈕。"
        button = await _single(page, '[data-heph-submit="1"]')
        if button is None:
            return False, "沒有送出：找不到「確認訂位」按鈕。"
        await button.scroll_into_view()
        # 結果以訂位 API 的回應判斷，所以一律錄網路；只有 TRACE_ENABLED 時才寫成 network.json。
        recorder = NetworkRecorder(session, self.data)
        recorder.start()
        try:
            self.maybe_submitted = True  # 先記錄再點擊：之後無論發生什麼都不可重跑
            await button.click()
            kind, evidence, order_no = await joymap.await_outcome(page, lambda: recorder.response_body(joymap.ORDER_API))
            if kind == "error":
                await asyncio.sleep(2)  # 讓錯誤前後的請求都收完，再交給 recorder
        finally:
            recorder.stop()
            if TRACE_ENABLED:
                try:
                    self.network = await recorder.collect()
                except Exception as exc:
                    self.network = {"error": type(exc).__name__}
        if kind == "success":
            self.success_seen = evidence
            self.confirmation_no = order_no
            number = f"訂位編號 {order_no}" if order_no else "沒有取得訂位編號"
            outcome = (True, f"已按下「確認訂位」：{evidence}({number})。請以 done 回傳 kind=success。")
        elif kind == "error":
            self.error_seen = evidence
            outcome = (False, f"已按下「確認訂位」，{evidence}。不要再按，以 done 回傳 kind=ambiguous、stage=booking_error，message 寫出畫面上的錯誤訊息。")
        else:
            outcome = (False, "已按下「確認訂位」，20 秒內沒有看到成功字樣。請用 wait 再觀察一次畫面；看到成功字樣回傳 kind=success，否則回傳 kind=ambiguous。")
        if self.network is not None:
            self.network["outcome"] = {"success_seen": self.success_seen, "error_seen": self.error_seen}
        return outcome


async def run_agent(
    task: str,
    schema: type[BaseModel],
    attempts: int = 1,
    trace: TraceWriter | None = None,
    guard: SubmitGuard | None = None,
) -> tuple[BaseModel, object]:
    # Docker 內 Chromium 偶發 detached target 時，只有唯讀 inspect 可以在這裡重試。
    # submit 一律 attempts=1：是否能重跑由 submit() 依 SubmitGuard 判斷，絕不在可能已送出後重送。
    last_error: Exception | None = None
    for attempt in range(attempts):
        session: BrowserSession | None = None
        try:
            session = browser()
            tools = None
            if guard is not None:
                tools = Tools()
                for name in list(tools.registry.registry.actions):
                    if name not in SUBMIT_ALLOWED_ACTIONS:
                        tools.exclude_action(name)
                confirmed = guard.data

                @tools.action(
                    "以程式填寫訂位資料頁：真實姓名、稱謂、電子郵件、手機號碼、用餐目的、訂位備註，並勾選同意條款，"
                    "再逐欄回讀和已確認方案比對(含頁面上方的日期、時間、人數)。值由系統提供。進入訂位資料頁後呼叫；回報不符時可再呼叫一次。",
                    param_model=FillContactFormParams,
                )
                async def fill_contact_form(params: FillContactFormParams, browser_session: BrowserSession) -> ActionResult:
                    ok, message = await joymap.fill(browser_session, confirmed)
                    return ActionResult(extracted_content=message, long_term_memory=message, error=None if ok else message)

                @tools.action(
                    "最終送出訂位：系統先重新核對表單與已確認方案，一致才按下「確認訂位」，並回報按下後頁面出現的文字。"
                    "fill_contact_form 驗證通過後呼叫。只呼叫一次，不要自己點「確認訂位」按鈕。",
                    param_model=SubmitReservationParams,
                )
                async def submit_reservation(params: SubmitReservationParams, browser_session: BrowserSession) -> ActionResult:
                    ok, message = await guard.submit(browser_session)
                    return ActionResult(extracted_content=message, long_term_memory=message, error=None if ok else message)

            async def on_step(state, output, step_number: int) -> None:
                if trace:
                    await trace.capture_step(state, output, step_number)
                if guard:
                    # 例外會讓 browser-use 把這一步記為失敗、不執行該 action，並把訊息回給 LLM。
                    await guard.check(state, output, session)

            if trace:
                trace.begin_attempt()
            agent = Agent(
                task=task,
                llm=llm(),
                browser_session=session,
                tools=tools,
                output_model_schema=schema,
                max_failures=3,
                max_actions_per_step=1,
                # "auto" 只有 agent 主動呼叫 screenshot 才看得到畫面，曾導致它看不到 DOM 沒表達的狀態而反覆確認。每步都附截圖。
                use_vision=True,
                use_thinking=True,
                use_judge=False,
                directly_open_url=True,
                register_new_step_callback=on_step if (trace or guard) else None,
            )
            history = await asyncio.wait_for(agent.run(max_steps=MAX_STEPS), timeout=ATTEMPT_TIMEOUT_SEC)
            result = history.structured_output
            if result is None:
                raise RuntimeError("agent did not return structured output")
            return result, history
        except Exception as exc:
            last_error = exc
            if attempt < attempts - 1:
                await asyncio.sleep(1)
        finally:
            if session is not None:
                try:
                    await session.close()
                except Exception:
                    pass
    raise RuntimeError("agent failed after local-browser retry") from last_error


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "browser-agent", "target": TARGET_URL, "submit": SUBMIT_ENABLED}


@app.post("/internal/browser-agent/submit", response_model=SubmitResult)
async def submit(data: SubmitRequest, x_internal_token: str | None = Header(default=None)):
    require_token(x_internal_token)
    require_target(data.url)
    dry_run = not SUBMIT_ENABLED
    task = joymap.task(data, dry_run)
    trace = TraceWriter(data.booking_id)
    deadline = time.monotonic() + SUBMIT_BUDGET_SEC
    last_error: Exception | None = None
    # 最多兩次。只有 SubmitGuard 確定「從沒按過最終訂位」才會進到第二次，因此不可能重複送出。
    for attempt in (1, 2):
        guard = SubmitGuard(dry_run, data)
        result: SubmitResult | None = None
        try:
            result, _history = await run_agent(task, SubmitResult, attempts=1, trace=trace, guard=guard)
        except Exception as exc:
            last_error = exc
            cause = exc.__cause__ or exc
            # 只記錯誤類別，不記訊息：訊息可能含 task(個資)。
            logging.getLogger("browser-agent").warning("submit attempt %d failed: %s", attempt, type(cause).__name__)
        if guard.network is not None:
            trace.write_network(guard.network)

        if guard.maybe_submitted:
            # 按過(或可能按過)最終訂位：只能是成功或結果不明，絕不重跑。
            trace.finalize("completed" if result else "failed", None if result else last_error)
            if guard.success_seen:
                # 程式在按下後親自讀到成功字樣；即使 LLM 之後出錯，也不能把成功的訂位報成不明。
                return SubmitResult(
                    kind="success",
                    confirmation_no=guard.confirmation_no or "JoyMap 已訂位",
                    evidence=[guard.success_seen],
                    trace=trace.trace(),
                )
            # 程式沒讀到成功字樣：不採信 LLM 的成功宣告(成功字樣清單在第一筆真實訂位後校正)。
            stage = "evidence_missing" if result and result.kind == "success" else (result.stage if result and result.stage else "after_submit")
            message = result.message if result and result.message else "已按下「確認訂位」，但沒有看到明確的成功畫面"
            return SubmitResult(kind="ambiguous", stage=stage, message=message, trace=trace.trace())

        # 以下皆確定沒有按過最終訂位 → 店家沒有收到任何東西。
        if result and result.kind == "success":
            # 程式從沒按過「確認訂位」，LLM 卻宣稱成功：和程式觀察矛盾。保守地當成不明，不讓使用者以為可以重訂。
            trace.finalize("completed")
            return SubmitResult(kind="ambiguous", stage="guard_mismatch", message="agent 宣稱成功，但沒有觀察到按下確認訂位", trace=trace.trace())
        if result and result.kind == "rejected":
            trace.finalize("completed")
            return result.model_copy(update={"trace": trace.trace()})
        if attempt == 1 and deadline - time.monotonic() > ATTEMPT_TIMEOUT_SEC:
            continue
        trace.finalize("completed" if result else "failed", None if result else last_error)
        return SubmitResult(
            kind="rejected",
            code="NOT_SUBMITTED",
            message="訂位助手沒能完成填寫，沒有按下確認訂位，店家不會收到這筆訂位。請稍後再試一次。",
            stage="pre_submit",
            trace=trace.trace(),
        )
    raise AssertionError("unreachable")


def safe_url(value: str) -> str:
    """截圖 manifest 只保留 origin/path，不保存可能含 query 個資的參數。"""
    from urllib.parse import urlsplit

    parsed = urlsplit(value)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}" if parsed.scheme and parsed.netloc else ""
