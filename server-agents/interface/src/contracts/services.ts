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
  AgentCompactRequest,
  AgentExecutionContext,
  AgentResumeRequest,
  AgentStartedSession,
} from './execution.js';
import type {
  AgentCompactRequestV4,
  AgentExecutionContextV4,
  AgentResumeRequestV4,
  AgentTranscriptAdmissionIdentity,
} from './execution-events-v4.js';
import type { AgentMigrationStore } from './host.js';
import type { AgentChatReference, AgentNativeSessionRef } from './transcript.js';
import type {
  AgentChatReferenceV4,
  AgentForkPoint,
  AgentNativeForkRef,
  AgentNativeForkResolution,
} from './transcript-stream-v4.js';

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

export interface AgentSteeringV4 {
  captureTarget(request: AgentSteerTargetRequest): AgentSteerTarget | null;
  steer(request: AgentSteerRequestV4): Promise<AgentSteerResult>;
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

export interface AgentSteerRequestV4 extends AgentSteerRequest {
  readonly operation: AgentTranscriptAdmissionIdentity;
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

export interface AgentGoalsV4 {
  submitControl(request: AgentGoalControlRequestV4): Promise<boolean>;
}

export interface AgentGoalControlRequest extends AgentResumeRequest {
  readonly beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>;
}

export interface AgentGoalControlRequestV4 extends AgentResumeRequestV4 {
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
  compact(request: AgentCompactRequest): Promise<void>;
}

export interface AgentCompactionV4 {
  compact(request: AgentCompactRequestV4): Promise<void>;
}

export interface AgentForking {
  readonly supportsAtMessage: boolean;
  // Gates both whole-session and at-message forks: a running provider session must tolerate
  // having its transcript read and copied while it is still appending to it.
  readonly supportsWhileRunning: boolean;
  fork(request: AgentForkRequest): Promise<AgentForkOutcome>;
  discard(session: AgentStartedSession, signal: AbortSignal): Promise<void>;
}

export interface AgentForkingV4 {
  readonly supportsAtMessage: boolean;
  readonly supportsWhileRunning: boolean;
  resolvePoint(request: AgentForkPointResolutionRequestV4): Promise<AgentNativeForkResolution>;
  fork(request: AgentForkRequestV4): Promise<AgentForkOutcome>;
  discard(session: AgentStartedSession, signal: AbortSignal): Promise<void>;
}

export interface AgentForkPointResolutionRequestV4 {
  readonly source: AgentChatReferenceV4;
  readonly point: AgentForkPoint;
  readonly signal: AbortSignal;
}

export interface AgentForkRequestV4 extends AgentExecutionContextV4 {
  readonly source: AgentChatReferenceV4;
  readonly point: {
    readonly projection: AgentForkPoint;
    readonly native: AgentNativeForkRef;
  } | null;
}

// Distinguishes a copied provider session from a successful fork with no resumable provider state.
export type AgentForkOutcome =
  | { readonly kind: 'materialized'; readonly session: AgentStartedSession }
  | { readonly kind: 'unmaterialized' };

export interface AgentForkRequest extends AgentExecutionContext {
  readonly source: AgentChatReference;
  readonly point: {
    readonly messageSequence: number;
    readonly archivedMessageCount: number;
    readonly sourceRevision: { readonly nativePrefix: string; readonly carryOver: string };
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
