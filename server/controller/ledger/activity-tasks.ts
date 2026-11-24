import type { ChatRunOutcome } from '../../../common/chat-activity.js';

export interface LedgerActivityTask {
  readonly kind: 'read-run-outcome';
  readonly databasePath: string;
  readonly viewId: string;
  readonly beforeOrdinal: number;
}

export interface LedgerActivityResults {
  readonly 'read-run-outcome': ChatRunOutcome | null;
}
