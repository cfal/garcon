import type { AgentCatalogEntry } from '../../common/agents.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { ThinkingMode } from '../../common/chat-modes.js';
import { CHAT_ROW_CONTENT_MAX_BYTES } from '../../common/chat-row-contracts.js';
import type { ChatMessage } from '../../common/chat-types.js';
import {
  DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS,
  SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS,
  parseAgentSwitchContextWindowTokens,
  usableHandoffTokenBudget,
} from '../../common/handoff-sizing.js';
import type { CarriedContext, CostedCarriedContext } from '../../common/transcript-seed.js';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  RECENT_TURNS_VERBATIM,
  createCarryoverTranscript,
  createCarryoverTranscriptWithinCost,
  isProjectableMessage,
} from '../../common/transcript-seed.js';
import { isRecord } from '../../common/json.js';
import { resolveGenerationContextForSelection } from '../settings/generation-config-source.js';
import { resolveEffectiveGenerationConfig } from '../settings/generation-effective.js';
import {
  createGenerationRequestSignal,
} from '../settings/generation-limits.js';
import { DomainError } from '../lib/domain-error.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';
import {
  COMPACTION_QUERY_ATTEMPTS,
  estimateHandoffTokens,
  fitEstimatedTokenDocument,
  reducedCompactionEntryBudget,
} from './handoff-token-budget.js';
import type { CarryOverOutcome } from './carryover-outcome.js';

const logger = createLogger('chats:carryover-compaction');
const SUMMARY_OPEN = '<summary>';
const SUMMARY_CLOSE = '</summary>';
const utf8Encoder = new TextEncoder();
// The Direct runtime cap in server-agents/common/src/direct/single-query-options.ts
// must remain at least this large.
export const CARRYOVER_COMPACTION_TIMEOUT_MS = 5 * 60_000;

export interface CarryOverCompactionAgents {
  singleQueryRunsToolsWithoutPermission(agentId: string): boolean;
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
  getAgentReadinessMap(authByAgent?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAgentCatalogEntries?(): Promise<AgentCatalogEntry[]>;
  runSingleQuery(prompt: string, options: {
    agentId: string;
    model: string;
    cwd: string;
    projectPath: string;
    thinkingMode: ThinkingMode;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
    modelProtocol?: ApiProtocol | null;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface CarryOverCompactionDestination {
  readonly agentId: string;
  readonly model: string;
  readonly prompt: string | null;
}

export interface CarryOverCompactionDeps {
  readonly agents: CarryOverCompactionAgents;
  getUiSettings(): { agentSwitchCompaction?: unknown } | null | undefined;
  onCompactionStarted?(chatId: string): void;
}

export interface CarryOverCompactionInput {
  readonly operation: 'agent-switch' | 'fresh-start';
  readonly chatId: string;
  readonly projectPath: string;
  readonly messages: readonly ChatMessage[];
  readonly destination: CarryOverCompactionDestination;
  readonly signal?: AbortSignal;
}

interface FittedCompactionPrompt {
  readonly assembled: CostedCarriedContext;
  readonly prompt: string;
}

const UNRESOLVED = Symbol('compaction-selection-unresolved');

export class CarryOverCompactionService {
  constructor(private readonly deps: CarryOverCompactionDeps) {}

  async planFor(input: CarryOverCompactionInput): Promise<CarryOverOutcome> {
    const complete = createCarryoverTranscript(input.messages, 0);
    if (!complete) return { kind: 'no-history' };
    if (
      estimateHandoffTokens(complete.prefix)
      <= SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS
    ) {
      return { kind: 'complete', context: complete };
    }

    const selectionSignal = createGenerationRequestSignal(input.signal);
    let selection;
    try {
      selection = await this.#selection(selectionSignal);
    } catch (error) {
      input.signal?.throwIfAborted();
      throw compactionUnavailable(
        input,
        `the configured model could not be resolved (${errorMessage(error)})`,
      );
    }
    if (!selection) throw compactionRequired(input);
    if (selection === UNRESOLVED) {
      throw compactionUnavailable(
        input,
        'no generation-capable agent and model could be resolved',
      );
    }
    // Refuses transcript-influenced prompts when the one-shot integration can
    // act on the workspace without a permission gate.
    if (this.deps.agents.singleQueryRunsToolsWithoutPermission(selection.agentId)) {
      throw compactionUnavailable(
        input,
        `${selection.agentId} runs one-shot queries without a permission gate`,
      );
    }

    const boundary = spineStart(input.messages);
    const spine = input.messages.slice(boundary);
    const older = input.messages.slice(0, boundary);
    if (createCarryoverTranscript(spine, CARRYOVER_INJECTION_MAX_CHARS, { summary: '.' })
      ?.summaryTruncated) {
      throw compactionUnavailable(
        input,
        `the most recent turns already fill the ${CARRYOVER_INJECTION_MAX_CHARS} character carryover limit`,
      );
    }
    if (!older.some(isProjectableMessage)) {
      throw compactionUnavailable(
        input,
        'the complete history is inside the newest-three-turn verbatim spine and exceeds the 100,000 estimated-token uncompacted carry limit',
        input.operation === 'agent-switch'
          ? 'Continue with the current agent or start a new chat.'
          : 'Start a new chat to continue.',
      );
    }
    const first = fitCompactionPrompt(
      older,
      input.destination,
      selection.contextWindowTokens,
    );
    if (!first) {
      throw compactionUnavailable(input, 'the compaction prompt does not fit the configured window');
    }

    let lastFailure: unknown = new Error('Compaction did not run');
    for (let attempt = 0; attempt < COMPACTION_QUERY_ATTEMPTS; attempt += 1) {
      input.signal?.throwIfAborted();
      const fitted = attempt === 0
        ? first
        : fitCompactionPrompt(
          older,
          input.destination,
          selection.contextWindowTokens,
          reducedCompactionEntryBudget(first.entryBudgetTokens),
        );
      if (!fitted) {
        lastFailure = new Error('the reduced compaction prompt does not fit');
        break;
      }
      if (attempt === 0) this.deps.onCompactionStarted?.(input.chatId);
      try {
        const raw = await this.deps.agents.runSingleQuery(fitted.value.prompt, {
          agentId: selection.agentId,
          model: selection.model,
          cwd: input.projectPath,
          projectPath: input.projectPath,
          thinkingMode: selection.thinkingMode,
          apiProviderId: selection.apiProviderId,
          modelEndpointId: selection.modelEndpointId,
          modelProtocol: selection.modelProtocol,
          timeoutMs: CARRYOVER_COMPACTION_TIMEOUT_MS,
          signal: createGenerationRequestSignal(input.signal, CARRYOVER_COMPACTION_TIMEOUT_MS),
        });
        const summary = validateCompactionSummary(raw);
        const context = projectSummaryWithSpine(summary, spine);
        return { kind: 'compacted', context, summary };
      } catch (error) {
        input.signal?.throwIfAborted();
        lastFailure = error;
        logger.warn('Compaction attempt failed', {
          chatId: input.chatId,
          attempt: attempt + 1,
          contextWindowTokens: selection.contextWindowTokens,
          entryBudgetTokens: fitted.entryBudgetTokens,
          reason: errorMessage(error),
        });
      }
    }

    throw compactionFailed(input, lastFailure);
  }

  async #selection(signal: AbortSignal) {
    const persisted = this.deps.getUiSettings()?.agentSwitchCompaction;
    // Long-history compaction is an explicit opt-in even when generation model
    // discovery can auto-resolve a usable agent.
    if (!isRecord(persisted) || persisted.enabled !== true) return null;
    const context = await resolveGenerationContextForSelection(this.deps.agents, persisted, signal);
    const config = resolveEffectiveGenerationConfig({ persisted, ...context });
    if (!config.enabled || !config.agentId || !config.model) return UNRESOLVED;
    return {
      ...config,
      agentId: config.agentId,
      model: config.model,
      contextWindowTokens:
        parseAgentSwitchContextWindowTokens(persisted.contextWindowTokens)
        ?? DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS,
    };
  }
}

function fitCompactionPrompt(
  older: readonly ChatMessage[],
  destination: CarryOverCompactionDestination,
  contextWindowTokens: number,
  maximumEntryBudgetTokens?: number,
) {
  const usableTokens = usableHandoffTokenBudget(contextWindowTokens);
  return fitEstimatedTokenDocument<FittedCompactionPrompt>({
    usableTokens,
    fixedFrameTokens: estimateHandoffTokens(buildCompactionPrompt('', destination)),
    maximumEntryBudgetTokens,
    minimumEntryBudgetTokens: 1,
    render(entryBudgetTokens) {
      const assembled = createCarryoverTranscriptWithinCost(older, {
        maximumCost: entryBudgetTokens,
        cost: estimateHandoffTokens,
      });
      return assembled === null
        ? null
        : { assembled, prompt: buildCompactionPrompt(assembled.prefix, destination) };
    },
    document: ({ prompt }) => prompt,
    admittedEntryCost: ({ assembled }) => assembled.admissionCost,
  });
}

function validateCompactionSummary(raw: string): string {
  if (!raw.isWellFormed()) {
    throw new Error('Agent-switch compaction returned malformed Unicode');
  }
  const framed = raw.trim();
  if (!framed.startsWith(SUMMARY_OPEN) || !framed.endsWith(SUMMARY_CLOSE)) {
    throw new Error('Agent-switch compaction must return exactly one <summary> element');
  }
  const inner = framed.slice(SUMMARY_OPEN.length, -SUMMARY_CLOSE.length).trim();
  if (!inner) throw new Error('Agent-switch compaction returned an empty <summary>');
  if (/<\/?summary(?=[\s/>])/u.test(inner)) {
    throw new Error('Agent-switch compaction returned more than one <summary> element');
  }
  if (utf8Encoder.encode(inner).byteLength > CHAT_ROW_CONTENT_MAX_BYTES) {
    throw new Error(
      `Agent-switch compaction returned a summary larger than ${CHAT_ROW_CONTENT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return inner;
}

function projectSummaryWithSpine(
  summary: string,
  spine: readonly ChatMessage[],
): CarriedContext {
  const projected = createCarryoverTranscript(spine, CARRYOVER_INJECTION_MAX_CHARS, { summary });
  if (!projected || projected.summaryTruncated
    || projected.prefix.length > CARRYOVER_INJECTION_MAX_CHARS) {
    throw new Error(
      `Agent-switch compaction produced a summary too large for the ${CARRYOVER_INJECTION_MAX_CHARS} character carryover limit`,
    );
  }
  return projected;
}

function compactionRequired(input: CarryOverCompactionInput): DomainError {
  return new DomainError(
    'CARRYOVER_COMPACTION_REQUIRED',
    input.operation === 'agent-switch'
      ? "This chat's history is too large to carry directly. Enable agent-switch compaction in Settings to switch agents during long chats."
      : "This chat's history is too large to carry directly. Enable agent-switch compaction in Settings to restart long chats with their history.",
    422,
  );
}

function compactionUnavailable(
  input: CarryOverCompactionInput,
  reason: string,
  advice = 'Choose a different compaction model in Settings.',
): DomainError {
  const outcome = input.operation === 'agent-switch'
    ? 'The agent switch was not performed.'
    : 'No fresh agent session was started.';
  return new DomainError(
    'CARRYOVER_COMPACTION_UNAVAILABLE',
    `Agent-switch compaction is unavailable: ${reason}. ${outcome} ${advice}`,
    422,
  );
}

function compactionFailed(input: CarryOverCompactionInput, failure: unknown): DomainError {
  const outcome = input.operation === 'agent-switch'
    ? 'The agent switch was not performed.'
    : 'No fresh agent session was started.';
  return new DomainError(
    'CARRYOVER_COMPACTION_FAILED',
    `Agent-switch compaction failed after two attempts (${errorMessage(failure)}). ${outcome} Try again, reduce the configured context window, or choose a different compaction model in Settings.`,
    502,
    true,
    { cause: failure },
  );
}

// Splits on the assembler's pinned-turn boundary so the summary and spine
// describe disjoint history.
function spineStart(messages: readonly ChatMessage[]): number {
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type !== 'user-message') continue;
    userTurns += 1;
    if (userTurns === RECENT_TURNS_VERBATIM) return index;
  }
  return 0;
}

function buildCompactionPrompt(
  transcript: string,
  destination: CarryOverCompactionDestination,
): string {
  return [
    'Summarize the prior conversation below so another coding agent can continue the work.',
    `It will be continued by ${destination.agentId} using ${destination.model}.`,
    ...(destination.prompt ? [`Their next instruction is: ${destination.prompt}`] : []),
    'Bias the summary toward what that instruction needs.',
    '',
    'Reply with a single <summary> element containing these sections in order:',
    'the original objective, decisions and constraints already established, files changed,',
    'the current state of the work, and the immediate next step.',
    'Do not include a <carried-context> element and do not repeat the transcript verbatim.',
    '',
    transcript,
  ].join('\n');
}
