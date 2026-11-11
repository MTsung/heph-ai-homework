export interface UserRow {
  id: string;
  username: string;
  nickname: string;
  password_hash: string;
  created_at: Date;
}

export type UserIdentity = Pick<UserRow, 'id' | 'username' | 'nickname'>;

export interface Device {
  device_id: string;
  device_name: string;
}

/** 發到 evt:session 的事件(gateway 據此清快取、踢掉舊裝置) */
export interface SessionEvent {
  type: 'replaced' | 'revoked' | 'started';
  user_id: string;
  old_sid: string;
  new_sid?: string;
  new_device_name?: string;
}
