import { ServiceClient } from '../../../../../shared/client';
import type { BookingChannel, BookingOption } from '../types';
import { BrowserAgentChannel } from './browser-agent';
import { PlatformApiChannel } from './platform-api';
import { WebFormChannel } from './web-form';

export type ChannelRegistry = Record<BookingOption['channel'], BookingChannel>;

export function createChannels(agent: ServiceClient): ChannelRegistry {
  return {
    web_form: new WebFormChannel(),
    platform_api: new PlatformApiChannel(),
    browser_agent: new BrowserAgentChannel(agent),
  };
}
