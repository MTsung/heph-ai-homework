import { ServiceClient } from '@chat-app/shared/client';
import { urls } from '@chat-app/shared/config';

/** 後台呼叫的各服務內部 API */
export function createClients() {
  return {
    auth: new ServiceClient('auth', urls.auth(), 5000),
    character: new ServiceClient('character', urls.character(), 5000),
    chat: new ServiceClient('chat', urls.chat(), 5000),
    billing: new ServiceClient('billing', urls.billing(), 5000),
    booking: new ServiceClient('booking', urls.booking(), 5000),
  };
}

export type Clients = ReturnType<typeof createClients>;
