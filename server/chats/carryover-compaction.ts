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
import { isRecord } from '../../common/json.js';
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

// Distinguishes "the operator opted in but nothing resolved" from "switched off".
const UNRESOLVED = Symbol('compaction-selection-unresolved');

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
      this.#warnUnresolved(input, errorMessage(error));
      return direct();
    }
    if (!selection) return direct();
    // Enabled but unresolvable is not the same as disabled. Discovery turns
    // provider failures into empty catalogs, so an operator who opted in would
    // otherwise pay the full carryover cost with no indication of why.
    if (selection === UNRESOLVED) {
      this.#warnUnresolved(input, 'no generation-capable agent and model could be resolved');
      return direct();
    }

    const boundary = spineStart(input.messages);
    const spine = input.messages.slice(boundary);
    const older = input.messages.slice(0, boundary);
    const assembled = createCarryoverTranscript(older, CARRYOVER_COMPACTION_INPUT_MAX_CHARS);
    if (!assembled) return direct();
    // The spine is reserved whole, so a spine that already fills the injection
    // budget leaves no room for any summary. Probing with a one-character one
    // detects that before spending a half-megabyte query that could only be
    // discarded.
    if (createCarryoverTranscript(spine, CARRYOVER_INJECTION_MAX_CHARS, { summary: '.' })
      ?.summaryTruncated) {
      this.deps.warn(
        input.chatId,
        `Agent-switch compaction was skipped: the most recent turns already fill the ${CARRYOVER_INJECTION_MAX_CHARS} character limit. The full transcript was carried over instead.`,
      );
      return direct();
    }

    try {
      // This one-shot runs on a tool-capable agent. `RunSingleQueryOptions` has an
      // index signature, so a `permissionMode` passed here would type-check and
      // then be dropped by the runtime router, which never forwards it to the
      // provider. Stating the constraint that way would be worse than not
      // stating it, so it is left off: the transcript being summarized is
      // attacker-influenced content, and constraining this path needs the
      // provider-enforced no-tools mode tracked in the design document.
      const summary = await this.deps.agents.runSingleQuery(
        buildCompactionPrompt(assembled.prefix, input.destination),
        {
          agentId: selection.agentId,
          model: selection.model,
          cwd: input.projectPath,
          projectPath: input.projectPath,
          thinkingMode: selection.thinkingMode,
          apiProviderId: selection.apiProviderId,
          modelEndpointId: selection.modelEndpointId,
          modelProtocol: selection.modelProtocol,
          timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS,
          signal: generationSignal,
        },
      );
      const compacted = this.#validate(input.chatId, summary);
      if (!compacted) return direct();
      // The summary renders inside the same envelope as the spine, so the
      // injection ceiling is enforced once, by the assembler, rather than split
      // across two independently budgeted strings.
      const projected = createCarryoverTranscript(spine, CARRYOVER_INJECTION_MAX_CHARS, {
        summary: compacted,
      });
      // A truncated summary counts as overflow. The assembler shortens it rather
      // than letting it displace the spine, so the result always fits; without
      // this the operator would never learn their compaction model is too
      // verbose to carry.
      if (!projected || projected.summaryTruncated
        || projected.prefix.length > CARRYOVER_INJECTION_MAX_CHARS) {
        this.deps.warn(
          input.chatId,
          `Agent-switch compaction produced a summary too large to carry within the ${CARRYOVER_INJECTION_MAX_CHARS} character limit. The full transcript was carried over instead. Consider a different compaction model in Settings.`,
        );
        return direct();
      }
      return projected;
    } catch (error) {
      logger.warn('compaction failed:', errorMessage(error));
      // A cancelled start already tore the turn down; warning about it would put
      // a failure notice in a chat the user abandoned.
      if (input.signal?.aborted) return direct();
      this.deps.warn(
        input.chatId,
        `Agent-switch compaction failed (${errorMessage(error)}). The full transcript was carried over instead. Consider a different compaction model in Settings.`,
      );
      return direct();
    }
  }

  // A cancelled start already tore the turn down, so warning about it would put
  // a failure notice in a chat the user abandoned.
  #warnUnresolved(input: CarryOverCompactionInput, reason: string): void {
    if (input.signal?.aborted) return;
    this.deps.warn(
      input.chatId,
      `Agent-switch compaction is enabled but its model could not be resolved (${reason}). The full transcript was carried over instead. Choose a compaction model in Settings.`,
    );
  }

  #validate(chatId: string, raw: string): string | null {
    const open = raw.indexOf(SUMMARY_OPEN);
    const close = raw.lastIndexOf(SUMMARY_CLOSE);
    if (open === -1 || close <= open) {
      this.deps.warn(
        chatId,
        'Agent-switch compaction returned no <summary> element. The full transcript was carried over instead. Consider a different compaction model in Settings.',
      );
      return null;
    }
    // Returns the inner text; the assembler owns the element framing and the
    // budget, so no separator or ceiling is applied here.
    const inner = raw.slice(open + SUMMARY_OPEN.length, close).trim();
    if (!inner) {
      this.deps.warn(
        chatId,
        'Agent-switch compaction returned an empty <summary>. The full transcript was carried over instead. Consider a different compaction model in Settings.',
      );
      return null;
    }
    return inner;
  }

  async #selection(signal: AbortSignal) {
    const persisted = this.deps.getUiSettings()?.agentSwitchCompaction;
    // Requires an explicit opt-in rather than the effective `enabled`, which
    // `resolveEffectiveGenerationConfig` turns on for any workspace where some
    // agent happens to resolve. Chat titles can afford that default; issuing a
    // half-megabyte one-shot query on every handoff cannot.
    if (!isRecord(persisted) || persisted.enabled !== true) return null;
    const context = await resolveGenerationContextForSelection(this.deps.agents, persisted, signal);
    const config = resolveEffectiveGenerationConfig({ persisted, ...context });
    if (!config.enabled || !config.agentId || !config.model) return UNRESOLVED;
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
