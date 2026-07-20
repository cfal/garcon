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
  AgentExecutionContext,
  AgentStartedSession,
} from './execution.js';
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

export interface AgentForking {
  readonly supportsAtMessage: boolean;
  readonly supportsWhileRunning: boolean;
  fork(request: AgentForkRequest): Promise<AgentStartedSession>;
}

export interface AgentForkRequest extends AgentExecutionContext {
  readonly source: AgentChatReference;
  readonly point: {
    readonly messageSequence: number;
    readonly sourceRevision: { readonly native: string; readonly carryOver: string };
  } | null;
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
