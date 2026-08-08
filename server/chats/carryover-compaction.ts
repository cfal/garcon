// Optional model-driven reduction of a carried-over transcript. Assembles a much
// larger projection than the injection ceiling allows, has a model summarize the
// older part of it, and appends the newest turns verbatim so a lossy summary can
// never destroy the working set. Every failure falls back to the deterministic
// ladder at the injection ceiling, because a handoff must not depend on a model.
import type { ChatMessage } from '../../common/chat-types.js';
import type { CarriedContext } from '../../common/transcript-seed.js';
import {
  CARRYOVER_COMPACTION_INPUT_MAX_CHARS,
  CARRYOVER_INJECTION_MAX_CHARS,
  createCarryoverTranscript,
} from '../../common/transcript-seed.js';
import type { AgentCatalogEntry } from '../../common/agents.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { ThinkingMode } from '../../common/chat-modes.js';
import { resolveGenerationContextForSelection } from '../settings/generation-config-source.js';
import { resolveEffectiveGenerationConfig } from '../settings/generation-effective.js';
import {
  createGenerationRequestSignal,
  GENERATION_PROVIDER_TIMEOUT_MS,
} from '../settings/generation-limits.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('chats:carryover-compaction');
const SUMMARY_OPEN = '<summary>';
const SUMMARY_CLOSE = '</summary>';
// Matches the pin in the projection ladder so the spine and the summary describe
// disjoint halves of the transcript.
const SPINE_TURNS = 3;

export interface CarryOverCompactionAgents {
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
  getAgentReadinessMap(authByAgent?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAgentCatalogEntries?(): Promise<AgentCatalogEntry[]>;
  runSingleQuery(prompt: string, options: {
    agentId: string;
    model: string;
    cwd: string;
    projectPath: string;
    permissionMode: 'default';
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
  warn(chatId: string, message: string): void;
}

export interface CarryOverCompactionInput {
  readonly chatId: string;
  readonly projectPath: string;
  readonly messages: readonly ChatMessage[];
  readonly destination: CarryOverCompactionDestination;
  readonly signal?: AbortSignal;
}

export class CarryOverCompactionService {
  constructor(private readonly deps: CarryOverCompactionDeps) {}

  // Returns the text to inject. Never throws: a misconfigured or failing
  // compaction model degrades to the same projection the disabled path renders.
  async carriedContextFor(input: CarryOverCompactionInput): Promise<CarriedContext | null> {
    const direct = () => createCarryoverTranscript(input.messages, CARRYOVER_INJECTION_MAX_CHARS);
    const generationSignal = createGenerationRequestSignal(input.signal);
    let selection;
    try {
      selection = await this.#selection(generationSignal);
    } catch (error) {
      logger.warn('compaction model could not be resolved:', errorMessage(error));
      return direct();
    }
    if (!selection) return direct();

    const spine = input.messages.slice(spineStart(input.messages));
    const older = input.messages.slice(0, spineStart(input.messages));
    const spineText = createCarryoverTranscript(spine, CARRYOVER_INJECTION_MAX_CHARS)?.prefix ?? '';
    if (spineText.length >= CARRYOVER_INJECTION_MAX_CHARS) return direct();

    const assembled = createCarryoverTranscript(older, CARRYOVER_COMPACTION_INPUT_MAX_CHARS);
    if (!assembled) return direct();

    try {
      const summary = await this.deps.agents.runSingleQuery(
        buildCompactionPrompt(assembled.prefix, input.destination),
        {
          agentId: selection.agentId,
          model: selection.model,
          cwd: input.projectPath,
          projectPath: input.projectPath,
          permissionMode: 'default',
          thinkingMode: selection.thinkingMode,
          apiProviderId: selection.apiProviderId,
          modelEndpointId: selection.modelEndpointId,
          modelProtocol: selection.modelProtocol,
          timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS,
          signal: generationSignal,
        },
      );
      const compacted = this.#validate(input.chatId, summary, spineText.length);
      if (!compacted) return direct();
      return { prefix: `${compacted}${spineText}` };
    } catch (error) {
      logger.warn('compaction failed:', errorMessage(error));
      this.deps.warn(
        input.chatId,
        `Agent-switch compaction failed (${errorMessage(error)}). The full transcript was carried over instead. Consider a different compaction model in Settings.`,
      );
      return direct();
    }
  }

  #validate(chatId: string, raw: string, spineLength: number): string | null {
    const ceiling = CARRYOVER_INJECTION_MAX_CHARS - spineLength;
    const open = raw.indexOf(SUMMARY_OPEN);
    const close = raw.lastIndexOf(SUMMARY_CLOSE);
    if (open === -1 || close <= open) {
      this.deps.warn(
        chatId,
        'Agent-switch compaction returned no <summary> element. The full transcript was carried over instead. Consider a different compaction model in Settings.',
      );
      return null;
    }
    const summary = raw.slice(open, close + SUMMARY_CLOSE.length);
    if (summary.length > ceiling) {
      this.deps.warn(
        chatId,
        `Agent-switch compaction returned ${summary.length} characters, over the ${ceiling} limit. The full transcript was carried over instead. Consider a different compaction model in Settings.`,
      );
      return null;
    }
    return `${summary}\n\n`;
  }

  async #selection(signal: AbortSignal) {
    const persisted = this.deps.getUiSettings()?.agentSwitchCompaction;
    const context = await resolveGenerationContextForSelection(this.deps.agents, persisted, signal);
    const config = resolveEffectiveGenerationConfig({ persisted, ...context });
    if (!config.enabled || !config.agentId || !config.model) return null;
    return config as typeof config & { agentId: string; model: string };
  }
}

function spineStart(messages: readonly ChatMessage[]): number {
  let boundaries = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type !== 'user-message') continue;
    boundaries += 1;
    if (boundaries === SPINE_TURNS) return index;
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
