import pino from 'pino';
import { env } from './config';

export type Logger = pino.Logger;

export function createLogger(service: string): Logger {
  return pino({
    level: env('LOG_LEVEL', 'info'),
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
