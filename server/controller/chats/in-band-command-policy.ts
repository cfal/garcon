import type { TranscriptViewId } from '../ledger/contracts.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { IChatRegistry } from './store.js';

export function denyInBandCommand(
  source: { readonly chatId: string; readonly viewId: TranscriptViewId },
  registry: Pick<IChatRegistry, 'getChat'>,
  notices: Pick<TranscriptLedgerService, 'appendNotice'>,
): boolean {
  if (registry.getChat(source.chatId)?.automationPolicy?.inBandCommands !== 'deny') return false;
  notices.appendNotice(source.chatId, source.viewId, {
    at: new Date().toISOString(), title: 'Command denied',
    content: 'In-band orchestration is disabled for this chat. No command was executed.',
    detail: { type: 'in-band-command-denied' },
  });
  return true;
}
