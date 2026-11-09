import {
  ChannelError,
  type BookingChannel,
  type BookingOption,
  type Inspection,
  type Plan,
  type SubmitOutcome,
} from '../types';

// ============================================================================ 解析 HTML
interface FormField {
  name: string;
  type: string;
  required: boolean;
  label?: string;
  options?: string[]; // 下拉選單的選項(不含空白選項)
}

interface ParsedPage {
  form?: { action: string; hidden: Record<string, string>; fields: Map<string, FormField> };
  /** 頁面上的提示(公休、無空位…),帶 data-code */
  notice?: { code: string; text: string };
  /** 送出後的結果頁 */
  result?: { ok: boolean; code?: string; text: string; confirmationNo?: string };
}

/**
 * 用 Bun 內建的 HTMLRewriter(串流式 HTML 解析器)讀頁面,不需要額外套件、也不需要瀏覽器。
 * 限制:看不到 JavaScript 動態產生的內容。遇到那種網站要換成真正的瀏覽器自動化(Playwright)。
 */
export async function parsePage(html: string): Promise<ParsedPage> {
  const page: ParsedPage = {};
  const labels = new Map<string, string>(); // for → 文字
  const idToName = new Map<string, string>();
  let labelFor: string | undefined;
  let select: FormField | undefined;
  let optValue: string | undefined;
  let noticeAcc: { code: string; text: string } | undefined;
  let resultAcc: { ok: boolean; code?: string; text: string } | undefined;
  let confirmation = '';
  let inConfirmation = false;

  const addField = (f: FormField, id?: string) => {
    page.form?.fields.set(f.name, f);
    if (id) idToName.set(id, f.name);
  };

  const rewriter = new HTMLRewriter()
    .on('form', {
      element(el) {
        page.form = { action: el.getAttribute('action') ?? '', hidden: {}, fields: new Map() };
      },
    })
    .on('input', {
      element(el) {
        const name = el.getAttribute('name');
        if (!name || !page.form) return;
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        if (type === 'hidden') page.form.hidden[name] = el.getAttribute('value') ?? '';
        else addField({ name, type, required: el.hasAttribute('required') }, el.getAttribute('id') ?? undefined);
      },
    })
    .on('textarea', {
      element(el) {
        const name = el.getAttribute('name');
        if (name) addField({ name, type: 'textarea', required: el.hasAttribute('required') }, el.getAttribute('id') ?? undefined);
      },
    })
    .on('select', {
      element(el) {
        const name = el.getAttribute('name');
        if (!name) return;
        select = { name, type: 'select', required: el.hasAttribute('required'), options: [] };
        addField(select, el.getAttribute('id') ?? undefined);
        el.onEndTag(() => {
          select = undefined;
        });
      },
    })
    .on('option', {
      element(el) {
        optValue = el.getAttribute('value') ?? undefined;
        if (select && optValue) select.options!.push(optValue);
      },
    })
    .on('label', {
      element(el) {
        labelFor = el.getAttribute('for') ?? undefined;
      },
      text(t) {
        if (labelFor) labels.set(labelFor, (labels.get(labelFor) ?? '') + t.text);
      },
    })
    .on('[data-code]', {
      element(el) {
        const code = el.getAttribute('data-code')!;
        if (el.getAttribute('id') === 'result') resultAcc = { ok: false, code, text: '' };
        else noticeAcc = { code, text: '' };
      },
      text(t) {
        if (resultAcc && !resultAcc.text) resultAcc.text = '';
        if (resultAcc) resultAcc.text += t.text;
        else if (noticeAcc) noticeAcc.text += t.text;
      },
    })
    .on('#result.success', {
      element() {
        resultAcc = { ok: true, text: '' };
      },
      text(t) {
        if (resultAcc?.ok) resultAcc.text += t.text;
      },
    })
    .on('#confirmation-code', {
      element(el) {
        inConfirmation = true;
        el.onEndTag(() => {
          inConfirmation = false;
        });
      },
      text(t) {
        if (inConfirmation) confirmation += t.text;
      },
    });

  await rewriter.transform(new Response(html)).text();

  // 欄位的人類可讀名稱來自 <label for=id>
  if (page.form) {
    for (const [id, name] of idToName) {
      const f = page.form.fields.get(name);
      const text = labels.get(id)?.trim();
      if (f && text) f.label = text;
    }
  }
  if (noticeAcc) page.notice = { code: noticeAcc.code, text: noticeAcc.text.trim() };
  if (resultAcc) {
    page.result = {
      ok: resultAcc.ok,
      code: resultAcc.code,
      text: resultAcc.text.replace(/\s+/g, ' ').trim(),
      confirmationNo: confirmation.trim() || undefined,
    };
  }
  return page;
}

// ============================================================================ 通道
const KNOWN = new Set(['date', 'party_size', 'time', 'name', 'phone', 'email', 'notes']);

async function fetchPage(url: string, signal: AbortSignal): Promise<ParsedPage> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'text/html' }, redirect: 'follow' });
  } catch (e) {
    throw new ChannelError(`無法連線到店家網頁:${(e as Error).message}`);
  }
  if (!res.ok) throw new ChannelError(`店家網頁回應 ${res.status}`);
  return parsePage(await res.text());
}

const pageUrl = (option: Extract<BookingOption, { channel: 'web_form' }>, date: string, party: number) => {
  const u = new URL(option.url);
  u.searchParams.set('date', date);
  u.searchParams.set('party', String(party));
  return u.toString();
};

/**
 * 操作餐廳自家的訂位網頁。
 *
 * 刻意不讓 LLM 決定「填什麼」:要送出的每個值都直接來自使用者確認過的方案(Plan),
 * 程式只負責把方案對應到表單欄位。這樣不論模型怎麼想,送出去的內容都和使用者確認的一致,
 * 也不會有不可重現的行為。表單裡有程式不認得的必填欄位時,在「確認前」就會變成問題問使用者(見 dialog.ts),
 * 執行時才發現就直接中止、不送出。
 */
export class WebFormChannel implements BookingChannel {
  readonly id = 'web_form' as const;
  readonly idempotent = false; // 網頁表單沒有冪等機制:重送 = 重複訂位
  readonly limited = true;

  async inspect(option: BookingOption, date: string, party: number, signal: AbortSignal): Promise<Inspection> {
    if (option.channel !== 'web_form') throw new ChannelError('訂位管道不符');
    const page = await fetchPage(pageUrl(option, date, party), signal);
    if (page.notice && !page.form) return { bookable: false, reason: page.notice.text, times: [], requiredContact: [], extraFields: [] };
    const form = page.form;
    if (!form) throw new ChannelError('看不懂店家的訂位頁面(找不到表單)');

    const times = form.fields.get('time')?.options ?? [];
    const parties = (form.fields.get('party_size')?.options ?? []).map(Number).filter(Number.isFinite);
    const requiredContact = (['name', 'phone', 'email'] as const).filter((k) => form.fields.get(k)?.required);
    const extraFields = [...form.fields.values()]
      .filter((f) => !KNOWN.has(f.name) && f.required)
      .map((f) => ({ key: f.name, label: f.label ?? f.name, options: f.options }));
    return {
      bookable: times.length > 0,
      reason: times.length > 0 ? undefined : '這天沒有可訂的時段',
      times,
      maxParty: parties.length ? Math.max(...parties) : undefined,
      requiredContact,
      extraFields,
    };
  }

  async submit(plan: Plan, _key: string, beforeSend: () => Promise<void>, signal: AbortSignal): Promise<SubmitOutcome> {
    const option = plan.target;
    if (option.channel !== 'web_form') return { kind: 'rejected', code: 'CHANNEL_MISMATCH', message: '訂位管道不符' };
    const notSent = (code: string, message: string): SubmitOutcome => ({ kind: 'rejected', code, message: `${message}(尚未送出訂位)` });

    // 1) 送出前重新讀一次表單(取得有效的 token,並確認內容沒有變)。這一步還沒有任何副作用。
    const url = pageUrl(option, plan.date, plan.party_size);
    let page: ParsedPage;
    try {
      page = await fetchPage(url, signal);
    } catch (e) {
      return notSent('CHANNEL_UNAVAILABLE', (e as Error).message);
    }
    if (!page.form) return notSent('SLOT_UNAVAILABLE', page.notice?.text ?? '店家頁面沒有可用的表單');
    const form = page.form;
    if (!(form.fields.get('time')?.options ?? []).includes(plan.time)) return notSent('SLOT_UNAVAILABLE', `${plan.time} 已經沒有空位`);

    // 2) 方案 → 表單欄位。每個必填欄位都必須找得到來源,否則不送。
    const values: Record<string, string | undefined> = {
      date: plan.date,
      party_size: String(plan.party_size),
      time: plan.time,
      name: plan.contact.name,
      phone: plan.contact.phone,
      email: plan.contact.email,
      notes: plan.notes,
      ...plan.extra,
    };
    for (const f of form.fields.values()) {
      if (f.required && !values[f.name]) return notSent('FORM_CHANGED', `店家表單新增了必填欄位「${f.label ?? f.name}」`);
      if (f.options && values[f.name] && !f.options.includes(values[f.name]!)) {
        return notSent('FORM_CHANGED', `欄位「${f.label ?? f.name}」沒有「${values[f.name]}」這個選項`);
      }
    }
    const body = new URLSearchParams(form.hidden);
    for (const f of form.fields.values()) if (values[f.name]) body.set(f.name, values[f.name]!);

    // 3) 過了這一步,請求就可能已經到達對方 —— 先把這件事記下來
    await beforeSend();
    let res: Response;
    try {
      res = await fetch(new URL(form.action, url), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch (e) {
      return { kind: 'ambiguous', reason: `送出後沒有收到回應:${(e as Error).message}` };
    }
    let parsed: ParsedPage;
    try {
      parsed = await parsePage(await res.text());
    } catch (e) {
      return { kind: 'ambiguous', reason: `回應中斷:${(e as Error).message}` };
    }
    if (parsed.result?.ok && parsed.result.confirmationNo) return { kind: 'success', confirmationNo: parsed.result.confirmationNo };
    if (parsed.result && !parsed.result.ok) {
      return { kind: 'rejected', code: parsed.result.code ?? 'REJECTED', message: parsed.result.text || '店家拒絕了這筆訂位' };
    }
    return { kind: 'ambiguous', reason: `看不懂店家的回應(HTTP ${res.status})` };
  }
}
