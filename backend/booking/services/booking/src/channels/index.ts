import { ServiceClient } from '../../../../../shared/client';
import type { BookingChannel, BookingOption } from '../types';
import { BrowserAgentChannel } from './browser-agent';

export type ChannelRegistry = Record<BookingOption['channel'], BookingChannel>;

export function createChannels(agent: ServiceClient): ChannelRegistry {
  return {
    browser_agent: new BrowserAgentChannel(agent),
  };
}
