import type {
  AgentTerminalEvent,
  AgentTurnBoundOperationIdentityV4,
  AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import { auditNativeEvidence } from './native-audit.js';
import { applyAuditMetadata } from './journal-metadata.js';
import { aliasesFromSeeds, seedEntries } from './seed-entries.js';
import type {
  AgentProviderSettlement,
  JournalBackedTranscriptStreamOptions,
  OpenSegment,
} from './journal-stream.js';

const SETTLEMENT_WAIT_MS = 1_500;
const SETTLEMENT_POLL_INTERVAL_MS = 25;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The terminal a proven boundary publishes inside its own gated operation, so
// no successor admission interleaves between the settlement and its terminal.
export interface NativeBoundaryTerminal {
  readonly operation: AgentTurnOwnerOperationIdentityV4;
  readonly outcome: AgentTerminalEvent['outcome'];
  readonly sourceSettlement: AgentTerminalEvent['sourceSettlement'];
}

export interface NativeBoundaryRequest {
  readonly signal: AbortSignal;
  readonly operation?: AgentTurnBoundOperationIdentityV4 | null;
  readonly sourceSettlement?: () => Promise<AgentProviderSettlement>;
  readonly terminal?: (settlement: 'confirmed' | 'unresolved') => NativeBoundaryTerminal;
}

export interface NativeBoundaryDeps {
  readonly segment: OpenSegment;
  readonly ownerId: string;
  readonly bootstrap: JournalBackedTranscriptStreamOptions['bootstrap'];
  readonly publishTerminal: (terminal: NativeBoundaryTerminal) => Promise<void>;
}

// Proof-first terminal native boundary. Runs inside the segment's mutation
// gate, publishing the turn terminal in the same gated operation so no
// successor admission interleaves. Success requires both the provider proof and
// a settled native audit: a provider hook proves only that its expected
// streamed occurrences persisted, never that every provider output was
// observed, so an unresolved hook fails closed and a confirmed hook still needs
// the audit to establish no provider-owed output was missed.
export async function settleNativeBoundaryOnSegment(
  deps: NativeBoundaryDeps,
  request: NativeBoundaryRequest,
): Promise<'confirmed' | 'unresolved'> {
  const { segment } = deps;
  return segment.gate.run(async () => {
    const finish = async (verdict: 'confirmed' | 'unresolved') => {
      if (request.terminal) await deps.publishTerminal(request.terminal(verdict));
      return verdict;
    };
    const proof = request.sourceSettlement
      ? await request.sourceSettlement()
      : null;
    // The hook and audit combine at each conclusion, so a confirmed hook never
    // overrides unavailable, ambiguous, or ahead evidence.
    const hookProven = proof === null || proof.verdict === 'confirmed';
    // Providers persist native records asynchronously relative to their stream
    // terminals, so a boundary whose evidence has not caught up yet rereads
    // boundedly before concluding. A provider settlement hook owns its own
    // wait, so hook boundaries read exactly once.
    const deadline = Date.now() + (request.sourceSettlement ? 0 : SETTLEMENT_WAIT_MS);
    for (;;) {
      const evidence = await deps.bootstrap({ chat: segment.chat, signal: request.signal });
      // Unavailable evidence cannot exclude missed provider output and so never
      // proves settlement, whatever the hook reported.
      if (evidence.kind !== 'ready') return finish('unresolved');
      const state = segment.journal.state;
      const outcome = auditNativeEvidence({
        ownerId: deps.ownerId,
        entries: state.entries,
        seeds: evidence.value,
        aliases: state.aliases,
        itemAliases: proof?.itemAliases,
      });
      if (outcome.kind === 'skipped') {
        // The proof obligation is vacuous only when no durable row claims a
        // provider-native identity: a cancelled-before-start or output-free
        // turn left nothing the provider owes evidence for. Owner-native rows
        // facing ambiguous evidence cannot be proved complete.
        const namespace = `${deps.ownerId}:native`;
        const providerOwedRows = state.entries.some((entry) => (
          entry.lifetime === 'durable'
          && entry.source?.namespace === namespace
          && !entry.source.itemId.startsWith('event:')
        ));
        if (providerOwedRows && Date.now() < deadline) {
          await sleep(SETTLEMENT_POLL_INTERVAL_MS);
          continue;
        }
        return finish(hookProven && !providerOwedRows ? 'confirmed' : 'unresolved');
      }
      if (outcome.kind === 'diverged') {
        if (state.nativeContinuity !== 'diverged') {
          await segment.journal.updateNativeMetadata({
            nativeRetentionFloor: state.nativeRetentionFloor,
            aliases: state.aliases,
            nativeContinuity: 'diverged',
          });
        }
        // Divergence at an already committed source degrades resume/fork
        // continuity but does not fail the just-finished turn's completeness.
        return finish(hookProven ? 'confirmed' : 'unresolved');
      }
      if (outcome.aheadFromOrdinal !== null && Date.now() < deadline) {
        await sleep(SETTLEMENT_POLL_INTERVAL_MS);
        continue;
      }
      if (outcome.suffix.length > 0) {
        const provenance = request.operation
          ? { ...request.operation, upstreamRequestId: null }
          : null;
        await segment.stream.commit([], seedEntries(segment.chat, outcome.suffix).map((entry) => (
          entry.provenance || !provenance ? entry : { ...entry, provenance }
        )));
      }
      await applyAuditMetadata(segment.journal, outcome, aliasesFromSeeds(outcome.suffix));
      segment.nativeAheadFromOrdinal = outcome.aheadFromOrdinal;
      // A projection still ahead of the provider after its bounded wait has not
      // proved the committed suffix durable, so success is withheld even though
      // the audit aligned and any missed suffix was imported.
      return finish(hookProven && outcome.aheadFromOrdinal === null ? 'confirmed' : 'unresolved');
    }
  });
}
