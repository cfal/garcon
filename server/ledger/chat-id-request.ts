import type { LedgerRow, LedgerRowDraft } from './contracts.js';

export const CHAT_ID_REQUEST_NOTICE_TYPE = 'chat-id-request';

export function chatIdRequestNoticeDraft(at: string): LedgerRowDraft {
  return {
    kind: 'notice',
    at,
    message: 'Agent requested chat ID',
    detail: { type: CHAT_ID_REQUEST_NOTICE_TYPE },
    providerMeta: null,
  };
}

export function isChatIdRequestNoticeRow(row: LedgerRow): boolean {
  return row.kind === 'notice'
    && row.detail.type === CHAT_ID_REQUEST_NOTICE_TYPE;
}
