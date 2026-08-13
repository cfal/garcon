import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '@garcon/common/agent-auth';
import type {
  AgentAuthStatus,
  AgentEndpointSelection,
} from '@garcon/common/agent-execution';
import type {
  AgentSettingDescriptor,
  AgentSettingsEnvelope,
} from '@garcon/common/agent-integration';
import type { AgentModelOption } from '@garcon/common/agents';
import type { ThinkingMode } from '@garcon/common/chat-modes';
import type { JsonObject } from '@garcon/common/json';
import type { SlashCommand } from '@garcon/common/slash-commands';
import type {
  AgentExecutionHandle,
  AgentResumeRequestV5,
} from './execution-v5.js';
import type { AgentMigrationStore } from './host.js';
import type { AgentChatReference, AgentNativeSessionRef } from './transcript.js';

export interface AgentCatalog {
  snapshot(request: { readonly strict: boolean; readonly signal: AbortSignal }): Promise<{
    readonly models: readonly AgentModelOption[];
    readonly defaultModel: string;
    readonly requiresStrictModelDiscovery: boolean;
    readonly generation: { readonly priority: number; readonly model: string } | null;
  }>;
}

export interface AgentAttachments {
  readonly fileMimeTypes: readonly string[];
}

export interface AgentSettings {
  describe(): readonly AgentSettingDescriptor[];
  defaults(): AgentSettingsEnvelope;
  parse(input: AgentSettingsEnvelope): AgentSettingsEnvelope;
  migrate(input: AgentSettingsEnvelope): Promise<AgentSettingsEnvelope>;
  applyPatch(current: AgentSettingsEnvelope, patch: JsonObject): AgentSettingsEnvelope;
}

export interface AgentEndpoints {
  validate(selection: AgentEndpointSelection): Promise<void>;
}

export interface AgentAuth {
  status(signal: AbortSignal): Promise<AgentAuthStatus>;
  launchLogin?(): Promise<AgentAuthLoginLaunchResult>;
  completeLogin?(sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult>;
  loginStatus?(expectedSessionId?: string): AgentAuthLoginStatus;
}

export interface AgentCommands {
  discover(projectPath: string, signal: AbortSignal): Promise<readonly SlashCommand[]>;
}

export interface AgentSteering {
  captureTarget(request: AgentSteerTargetRequest): AgentSteerTarget | null;
  steer(request: AgentSteerRequest): Promise<AgentSteerResult>;
}

export type AgentSteerTarget = object;

export interface AgentSteerTargetRequest {
  readonly chatId: string;
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
}

export interface AgentSteerRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly target: AgentSteerTarget | null;
  readonly input: string;
  readonly clientMessageId: string;
  readonly prepareDelivery: () => Promise<void>;
}

export type AgentSteerRejectionReason =
  | 'no-active-turn'
  | 'turn-changed'
  | 'turn-not-steerable'
  | 'invalid-input'
  | 'provider-rejected';

export type AgentSteerResult =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected';
      readonly reason: AgentSteerRejectionReason;
      readonly message: string;
    }
  | {
      readonly kind: 'failed';
      readonly outcome: 'not-sent' | 'unknown';
      readonly message: string;
    };

export interface AgentGoals {
  submitControl(request: AgentGoalControlRequest): Promise<boolean>;
}

export interface AgentGoalControlRequest extends AgentResumeRequestV5 {
  readonly beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>;
}

export interface AgentGoalControlHandoff {
  validate(): void;
  commit(): void;
}

// Native, in-place context compaction. A provider that implements this rewrites
// its own session history and keeps everything the transcript does not capture:
// cached reads, plan state, MCP connections, session permission grants. Absent
// this facet the chat can still shed context through `/handoff`, which starts a
// fresh session from a projected transcript instead.
export interface AgentCompaction {
  compact(request: AgentResumeRequestV5): Promise<AgentExecutionHandle>;
}

export interface AgentLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  migrateOwnedStorage(store: AgentMigrationStore): Promise<void>;
}

export interface AgentMigration {
  translateLegacyNativeSession(request: {
    readonly chatId: string;
    readonly projectPath: string;
    readonly model: string;
    readonly agentSessionId: string | null;
    readonly legacyNativePath: string | null;
    readonly legacyValues: JsonObject;
    readonly signal: AbortSignal;
  }): Promise<AgentNativeSessionRef | null>;
  translateLegacySettings(request: {
    readonly scope: AgentLegacySettingsScope;
    readonly legacyValues: JsonObject;
    readonly signal: AbortSignal;
  }): Promise<AgentSettingsEnvelope | null>;
}

export type AgentLegacySettingsScope =
  | { readonly kind: 'chat'; readonly recordId: string; readonly selectedAgentId: string }
  | { readonly kind: 'scheduled-prompt'; readonly recordId: string; readonly selectedAgentId: string }
  | { readonly kind: 'execution-defaults'; readonly recordId: 'global' | string; readonly selectedAgentId: string | null };

export interface AgentSingleQuery {
  run(request: AgentSingleQueryRequest): Promise<string>;
  // Declares that this one-shot executes tools with no permission gate. Callers
  // that feed it untrusted text, such as transcript compaction, must refuse the
  // integration outright: the prompt would otherwise be able to act on the
  // workspace. Absent means the one-shot is not known to bypass permissions, not
  // that it is guaranteed tool-free; expressing that guarantee needs a tool
  // policy on the request, which no provider carries yet.
  readonly runsToolsWithoutPermission?: true;
}

export interface AgentSingleQueryRequest {
  readonly prompt: string;
  readonly projectPath: string;
  readonly model: string;
  readonly thinkingMode: ThinkingMode;
  readonly timeoutMs?: number;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
  readonly signal: AbortSignal;
}
