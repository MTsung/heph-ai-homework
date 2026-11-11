/** messages 表裡業務會用到的欄位(MSG_COLS) */
export interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  error_code: string | null;
  client_msg_id: string | null;
  attempt: number;
  hold_ref: string | null;
  billing_state: string;
  created_at: Date | string;
}

/** messages 整列(後台 / 除錯用) */
export interface FullMessageRow extends MessageRow {
  cost: number;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/** 對外的訊息格式(API 回應、SSE、最近訊息快取共用) */
export interface MessageDto {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  error_code?: string | null;
  client_msg_id?: string | null;
  created_at: string;
}

export function toDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    status: r.status,
    error_code: r.error_code,
    client_msg_id: r.client_msg_id,
    created_at: new Date(r.created_at).toISOString(),
  };
}

/** 對話列表 / 建立對話的回應格式 */
export interface ConversationView {
  id: string;
  character_id: string;
  last_message_at: Date;
  last_preview: string;
  latest_seq: number;
  created_at: Date;
}
