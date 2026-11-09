import { ServiceClient } from '../../../../../shared/client';
import { ChannelError, type BookingChannel, type BookingOption, type Inspection, type Plan, type SubmitOutcome } from '../types';

interface AgentSubmit {
  kind: 'success' | 'rejected' | 'ambiguous';
  confirmation_no?: string;
  code?: string;
  message?: string;
  stage?: string;
  evidence?: string[];
  trace?: { enabled: boolean; run_id?: string; manifest?: string; screenshot_count?: number; step_count?: number; started_at?: string; finished_at?: string };
}

/**
 * 享樂地圖(JoyMap)訂位頁的固定規則(2026-11 實測 jump888)。
 * 必填:真實姓名 + 稱謂、電子郵件、手機、用餐目的;單筆 1–8 位;時段 10:00–22:00 每 30 分鐘。
 * 稱謂與用餐目的用 extraFields 向使用者詢問,絕不替使用者猜(例如從名字猜性別)。
 */
const JOYMAP_EXTRA_FIELDS = [
  { key: 'title', label: '稱謂', options: ['先生', '小姐'] },
  { key: 'purpose', label: '用餐目的', options: ['朋友聚餐', '家庭聚會', '商務聚餐', '慶祝生日', '浪漫約會', '其他目的'] },
];
const JOYMAP_TIMES = Array.from({ length: 25 }, (_, i) => {
  const minutes = 10 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

/** browser-use agent 通道。它只接收 confirmed_plan，不負責找店、猜資料或改寫使用者確認過的內容。 */
export class BrowserAgentChannel implements BookingChannel {
  readonly id = 'browser_agent' as const;
  readonly idempotent = false;
  readonly limited = true;

  constructor(private readonly agent: ServiceClient) {}

  async inspect(option: BookingOption, _date: string, party: number, _signal: AbortSignal): Promise<Inspection> {
    if (option.channel !== 'browser_agent' || option.site !== 'joymap') throw new ChannelError('訂位管道不符');
    // 建立方案時不啟動瀏覽器:提供頁面已確認的固定規則,讓 App 能立即完成資料收集。
    // 當天公休 / 時段已滿由「確認後」的 agent 在真實頁面上檢查,選不到就回報 SLOT_UNAVAILABLE(不會送出)。
    return {
      bookable: party >= 1 && party <= 8,
      times: JOYMAP_TIMES,
      maxParty: 8,
      requiredContact: ['name', 'phone', 'email'],
      extraFields: JOYMAP_EXTRA_FIELDS,
    };
  }

  async submit(plan: Plan, key: string, beforeSend: () => Promise<void>, signal: AbortSignal): Promise<SubmitOutcome> {
    if (plan.target.channel !== 'browser_agent') return { kind: 'rejected', code: 'CHANNEL_MISMATCH', message: '訂位管道不符' };
    await beforeSend();
    try {
      const r = await this.agent.post<AgentSubmit>(
        '/internal/browser-agent/submit',
        { ...plan, booking_id: key, url: plan.target.url },
        // agent 端單次最多 270 秒，確定沒送出時最多重跑一次(總預算 560 秒)；這裡多留餘裕。
        { timeoutMs: 600_000 },
      );
      if (r.kind === 'success' && r.confirmation_no) return { kind: 'success', confirmationNo: r.confirmation_no, trace: r.trace };
      if (r.kind === 'rejected') return { kind: 'rejected', code: r.code ?? 'AGENT_REJECTED', message: r.message ?? '訂位 agent 拒絕執行', trace: r.trace };
      return { kind: 'ambiguous', reason: r.message ?? '訂位 agent 沒有確認結果', stage: r.stage ?? 'agent_ambiguous', trace: r.trace };
    } catch (e) {
      return signal.aborted
        ? { kind: 'ambiguous', reason: '訂位 agent 執行逾時', stage: 'agent_timeout' }
        : { kind: 'ambiguous', reason: `訂位 agent 無回應:${(e as Error).message}`, stage: 'agent_unavailable' };
    }
  }
}
