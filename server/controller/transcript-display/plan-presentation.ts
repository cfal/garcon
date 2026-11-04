import type { PlanPresentationRequest, PlanPresentationSnapshot } from '../../../common/transcript-display-open.js';
import { DomainError } from '../../common/domain-error.js';
import type { TranscriptCommitEvent } from '../ledger/contracts.js';

interface ChatPlans {
  viewId: string;
  revision: number;
  enter: number | null;
  exits: Map<number, string>;
}

export class ChatPlanPresentationStore {
  readonly #chats = new Map<string, ChatPlans>();
  constructor(readonly serverInstanceId: string) {}

  apply(event: TranscriptCommitEvent): void {
    if (event.type === 'view-replaced') { this.clear(event.chatId); return; }
    for (const row of event.type === 'rows' ? event.rows : [event.row]) {
      if (row.kind !== 'provider-row' || (row.message.type !== 'enter-plan-mode-tool-use' && row.message.type !== 'exit-plan-mode-tool-use')) continue;
      let plans = this.#chats.get(event.chatId);
      if (!plans || plans.viewId !== event.viewId) {
        plans = { viewId: event.viewId, revision: 0, enter: null, exits: new Map() };
        this.#chats.set(event.chatId, plans);
      }
      plans.revision++;
      if (row.message.type === 'enter-plan-mode-tool-use') plans.enter = row.ordinal;
      else plans.exits.set(row.ordinal, row.at);
    }
  }

  clear(chatId: string): void { this.#chats.delete(chatId); }
  snapshot(chatId: string, viewId: string, afterOrdinal = 0): PlanPresentationSnapshot {
    const found = this.#chats.get(chatId), plans = found?.viewId === viewId ? found : null;
    const exits: { ordinal: number; timestamp: string }[] = [];
    for (const [ordinal, timestamp] of plans?.exits ?? []) {
      if (ordinal > afterOrdinal) exits.push({ ordinal, timestamp });
      if (exits.length === 51) break;
    }
    return { serverInstanceId: this.serverInstanceId, chatId, transcriptViewId: viewId, revision: plans?.revision ?? 0,
      latestEnterOrdinal: plans?.enter ?? null, pendingExitCount: plans?.exits.size ?? 0, exits: exits.slice(0, 50),
      nextAfterOrdinal: exits.length > 50 ? exits[49].ordinal : null };
  }
  requirePending(request: PlanPresentationRequest): number {
    this.#instance(request);
    const plans = this.#chats.get(request.chatId), ordinal = request.ordinal;
    if (!ordinal || plans?.viewId !== request.transcriptViewId || !plans.exits.has(ordinal)) {
      throw new DomainError('DISPLAY_SUPERSEDED', 'This plan suggestion is no longer pending.', 409, false);
    }
    return ordinal;
  }
  dismiss(request: PlanPresentationRequest): PlanPresentationSnapshot {
    this.#instance(request);
    if (!request.ordinal) throw new TypeError('Plan ordinal is required');
    const plans = this.#chats.get(request.chatId);
    if (plans?.viewId === request.transcriptViewId && plans.exits.delete(request.ordinal)) plans.revision++;
    return this.snapshot(request.chatId, request.transcriptViewId);
  }
  #instance(request: PlanPresentationRequest): void {
    if (request.serverInstanceId !== this.serverInstanceId) throw new DomainError('DISPLAY_STALE_CERTIFICATE', 'Refresh the current plan suggestions.', 409, true);
  }
}
