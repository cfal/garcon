import { CHAT_START_ORIGINS } from '../../../../../common/chat-command-contracts.ts';

export function acceptsOrigin(value: unknown): boolean {
  return CHAT_START_ORIGINS.some(origin => origin === value);
}
