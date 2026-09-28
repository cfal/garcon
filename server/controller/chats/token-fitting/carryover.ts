import type { ChatMessage } from '../../../../common/chat-types.js';
import {
  SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS,
  usableHandoffTokenBudget,
} from '../../../../common/handoff-sizing.js';
import type { CarriedContext, CostedCarriedContext } from '../../../../common/transcript-seed.js';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  RECENT_TURNS_VERBATIM,
  createCarryoverTranscript,
  createCarryoverTranscriptWithinCost,
  isProjectableMessage,
} from '../../../../common/transcript-seed.js';
import { estimateHandoffTokens, fitEstimatedTokenDocument } from '../handoff-token-budget.js';

export interface CompactionDestination {
  readonly agentId: string;
  readonly model: string;
  readonly prompt: string | null;
}

export type CarryoverAssessment =
  | { readonly kind: 'no-history' }
  | { readonly kind: 'complete'; readonly context: CarriedContext }
  | { readonly kind: 'needs-compaction' };

export interface CompactionPromptInput {
  readonly messages: readonly ChatMessage[];
  readonly destination: CompactionDestination;
  readonly contextWindowTokens: number;
  readonly maximumEntryBudgetTokens: number | null;
}

export type CompactionPromptUnavailableReason =
  | 'recent-turns-fill-carryover'
  | 'history-inside-recent-turns'
  | 'recent-turns-unprojectable'
  | 'prompt-exceeds-window';

export type CompactionPromptFit =
  | { readonly kind: 'fitted'; readonly prompt: string; readonly entryBudgetTokens: number }
  | { readonly kind: 'unavailable'; readonly reason: CompactionPromptUnavailableReason };

interface FittedCompactionPrompt {
  readonly olderHistory: CostedCarriedContext;
  readonly prompt: string;
}

export function assessCarryover(messages: readonly ChatMessage[]): CarryoverAssessment {
  const complete = createCarryoverTranscript(messages, 0);
  if (!complete) return { kind: 'no-history' };
  return estimateHandoffTokens(complete.prefix) <= SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS
    ? { kind: 'complete', context: complete }
    : { kind: 'needs-compaction' };
}

export function fitCompactionPrompt(input: CompactionPromptInput): CompactionPromptFit {
  const boundary = spineStart(input.messages);
  const spine = input.messages.slice(boundary);
  const older = input.messages.slice(0, boundary);
  if (createCarryoverTranscript(spine, CARRYOVER_INJECTION_MAX_CHARS, { summary: '.' })
    ?.summaryTruncated) {
    return { kind: 'unavailable', reason: 'recent-turns-fill-carryover' };
  }
  if (!older.some(isProjectableMessage)) {
    return { kind: 'unavailable', reason: 'history-inside-recent-turns' };
  }
  const recentContext = createCarryoverTranscript(spine, 0);
  if (!recentContext) return { kind: 'unavailable', reason: 'recent-turns-unprojectable' };

  const fitted = fitEstimatedTokenDocument<FittedCompactionPrompt>({
    usableTokens: usableHandoffTokenBudget(input.contextWindowTokens),
    fixedFrameTokens: estimateHandoffTokens(
      buildCompactionPrompt('', recentContext.prefix, input.destination),
    ),
    maximumEntryBudgetTokens: input.maximumEntryBudgetTokens ?? undefined,
    minimumEntryBudgetTokens: 1,
    render(entryBudgetTokens) {
      const olderHistory = createCarryoverTranscriptWithinCost(older, {
        maximumCost: entryBudgetTokens,
        cost: estimateHandoffTokens,
      });
      return olderHistory === null
        ? null
        : {
            olderHistory,
            prompt: buildCompactionPrompt(
              olderHistory.prefix,
              recentContext.prefix,
              input.destination,
            ),
          };
    },
    document: ({ prompt }) => prompt,
    admittedEntryCost: ({ olderHistory }) => olderHistory.admissionCost,
  });
  if (!fitted) return { kind: 'unavailable', reason: 'prompt-exceeds-window' };
  return {
    kind: 'fitted',
    prompt: fitted.value.prompt,
    entryBudgetTokens: fitted.entryBudgetTokens,
  };
}

// Splits on the assembler's pinned-turn boundary so recent work remains a
// protected output spine while also informing the summary's current state.
export function spineStart(messages: readonly ChatMessage[]): number {
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type !== 'user-message') continue;
    userTurns += 1;
    if (userTurns === RECENT_TURNS_VERBATIM) return index;
  }
  return 0;
}

function buildCompactionPrompt(
  olderHistory: string,
  recentContext: string,
  destination: CompactionDestination,
): string {
  return [
    'Summarize the prior conversation below so another coding agent can continue the work.',
    `It will be continued by ${destination.agentId} using ${destination.model}.`,
    ...(destination.prompt ? [`Their next instruction is: ${destination.prompt}`] : []),
    'Bias the summary toward what that instruction needs.',
    'The conversation is split into older history and protected recent context.',
    'Use both sections to determine the current state and immediate next step.',
    'Recent completions, reversals, and blockers supersede older plans.',
    'The recent context will also accompany the summary, so account for it without repeating it in detail.',
    '',
    'Reply with a single <summary> element containing these sections in order:',
    'the original objective, decisions and constraints already established, files changed,',
    'the current state of the work, and the immediate next step.',
    'Do not include a <carried-context> element and do not repeat the transcript verbatim.',
    '',
    '<older-history>',
    olderHistory,
    '</older-history>',
    '',
    '<recent-context>',
    recentContext,
    '</recent-context>',
  ].join('\n');
}
