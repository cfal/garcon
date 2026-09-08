import {
  boundAgentChildResult,
  type AgentChildOutcomeNoticeDetail,
  type AgentChildTerminalOutcome,
} from '../../common/garcon-agent-result.js';
import type { CommandLedger, CommandLedgerRecord } from '../commands/command-ledger.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { AgentCommandReplies, type AgentCommandContext } from './agent-command-replies.js';

export interface ChildAdmission {
  readonly detail: AgentChildOutcomeNoticeDetail;
  readonly turnId: string | null;
  readonly recorded: boolean;
}

export interface AgentChildTurnReplyOptions extends AgentCommandContext {
  readonly turns: Pick<CommandLedger, 'waitForTurnTerminal'>;
}

export class AgentChildTurnReplies extends AgentCommandReplies {
  constructor(private readonly options: AgentChildTurnReplyOptions) { super(options); }

  launchChild(source: AgentCommandSource, admit: (signal: AbortSignal) => Promise<ChildAdmission | null>): void {
    this.launch(source, async (signal) => {
      const admission = await admit(signal);
      if (!admission || signal.aborted) return;
      const { detail, turnId } = admission;
      // Capture and bound completion before a slow acknowledgment can outlive receipt retention.
      const completion = detail.status === 'accepted' && !detail.async && turnId !== null
        ? this.options.turns.waitForTurnTerminal(detail.chatId, turnId, signal).then((record) =>
          boundAgentChildResult({ ...detail, ...terminalOutcome(record, detail.chatId) }),
        ).catch((error: unknown) => {
          if (!signal.aborted) this.report(source, 'receipt', error, detail);
          return null;
        })
        : null;
      if (admission.recorded) await this.deliver(source, detail, signal);
      if (!completion) return;
      const terminal = await completion;
      if (!terminal || signal.aborted) return;
      const recorded = await this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
        if (!this.current(source, signal)) return null;
        return this.record(source, terminal);
      });
      if (recorded) await this.deliver(source, recorded, signal);
    });
  }
}

function terminalOutcome(record: CommandLedgerRecord | null, chatId: string): AgentChildTerminalOutcome {
  if (!record) return { status: 'result-unavailable', chatId, reason: 'receipt-unavailable' };
  const projected = projectAgentTurnReceipt(record);
  if (projected.kind === 'expired') return { status: 'result-unavailable', chatId, reason: 'receipt-expired' };
  const { receipt } = projected;
  if (receipt.state === 'pending') return { status: 'result-unavailable', chatId, reason: 'receipt-unavailable' };
  const output = receipt.output.availability === 'unavailable' ? receipt.output : {
    availability: 'available' as const,
    completeness: receipt.output.completeness,
    text: receipt.output.assistantMessages.filter((message) => message.trim()).join('\n\n'),
  };
  switch (receipt.state) {
    case 'completed': return { status: 'completed', chatId, output };
    case 'failed': return { status: 'failed', chatId, errorCode: receipt.errorCode, output };
    case 'interrupted': return { status: 'interrupted', chatId, reason: receipt.reason, output };
  }
}
