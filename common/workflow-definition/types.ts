import type { AgentSettingsEnvelope } from '../agent-integration.js';
import type { PermissionMode, ThinkingMode } from '../chat-modes.js';
import type { ExecutorId } from '../executors.js';
import type { JsonPrimitive, JsonValue } from '../json.js';
import type { PreambleId } from '../preambles.js';

export const WORKFLOW_TURN_COMPLETED = 'turn_completed';
export const WORKFLOW_DEFINITION_LIMITS = {
  sourceBytes: 256 * 1024,
  promptBytes: 64 * 1024,
  steps: 64,
  edges: 1024,
  repeatConcurrency: 4,
} as const;

export type WorkflowValueType = 'string' | 'number' | 'boolean' | 'json';

export type WorkflowInput = { readonly description?: string } & (
  | { readonly type: 'string'; readonly default?: string }
  | { readonly type: 'number'; readonly default?: number }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | { readonly type: 'json'; readonly default?: JsonValue }
);

export type WorkflowSignalDefinition =
  | { readonly payload: 'none' | 'text'; readonly delivery: 'once' }
  | {
      readonly payload: 'json';
      readonly delivery: 'once';
      readonly fields?: Readonly<Record<string, WorkflowValueType>>;
    }
  | {
      readonly payload: 'json';
      readonly delivery: 'many';
      readonly fields: Readonly<Record<string, WorkflowValueType>>;
      readonly key: string;
    };

export interface WorkflowSignalReference {
  readonly stepId: string;
  readonly signal: string;
}

export type WorkflowSubscription =
  | { readonly kind: 'once'; readonly signal: WorkflowSignalReference }
  | { readonly kind: 'each'; readonly signal: WorkflowSignalReference; readonly maxConcurrency: number }
  | {
      readonly kind: 'all';
      readonly close: WorkflowSignalReference;
      readonly steps: readonly string[];
    };

export type WorkflowBinding =
  | { readonly kind: 'input'; readonly input: string }
  | { readonly kind: 'signal'; readonly field?: string }
  /** The joined group's complete terminal responses, as a JSON array. */
  | { readonly kind: 'all'; readonly stepId: string };

interface WorkflowStepBase {
  readonly id: string;
  readonly name?: string;
  readonly on?: WorkflowSubscription;
}

interface WorkflowExecutionStep extends WorkflowStepBase {
  /** Omission inherits the launch target. A path is always owned by the effective executor. */
  readonly executorId?: ExecutorId;
  readonly projectPath?: string;
}

export interface WorkflowAttachment {
  /** A source file on the step's executor, relative to the project folder or absolute. */
  readonly path: string;
}

export interface WorkflowAgentStep extends WorkflowExecutionStep {
  readonly kind: 'agent';
  readonly prompt: string;
  readonly bindings?: Readonly<Record<string, WorkflowBinding>>;
  readonly signals?: Readonly<Record<string, WorkflowSignalDefinition>>;
  readonly agentId?: string;
  readonly apiProviderId?: string | null;
  readonly modelEndpointId?: string | null;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  readonly thinkingMode?: ThinkingMode;
  readonly agentSettings?: AgentSettingsEnvelope;
  readonly orderedPreambleIds?: readonly PreambleId[];
  readonly attachments?: readonly WorkflowAttachment[];
  readonly tags?: readonly string[];
}

export interface WorkflowCommandStep extends WorkflowExecutionStep {
  readonly kind: 'command';
  readonly command: string;
  readonly shell?: string;
}

export interface WorkflowDecisionStep extends WorkflowStepBase {
  readonly kind: 'decision';
  readonly prompt: string;
  readonly bindings?: Readonly<Record<string, WorkflowBinding>>;
  /** Exactly one chosen name is emitted, with no payload. */
  readonly choices: Readonly<Record<string, string>>;
}

export type WorkflowStep = WorkflowAgentStep | WorkflowCommandStep | WorkflowDecisionStep;

export interface WorkflowDefinition {
  readonly version: 1;
  readonly name: string;
  readonly description?: string;
  readonly inputs: Readonly<Record<string, WorkflowInput>>;
  readonly steps: readonly WorkflowStep[];
}

export type WorkflowFieldPath = readonly (string | number)[];

export interface WorkflowSourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** Zero-based UTF-16 offsets, with one-based line/column and an exclusive end. */
export interface WorkflowSourceRange {
  readonly start: WorkflowSourcePosition;
  readonly end: WorkflowSourcePosition;
}

export type WorkflowDiagnosticCode =
  | 'source-limit'
  | 'yaml-syntax'
  | 'yaml-subset'
  | 'missing-field'
  | 'unknown-field'
  | 'invalid-type'
  | 'invalid-value'
  | 'duplicate-id'
  | 'unknown-step'
  | 'unknown-signal'
  | 'invalid-subscription'
  | 'cycle'
  | 'invalid-binding'
  | 'invalid-repeat-key'
  | 'invalid-edit';

export interface WorkflowDiagnostic {
  readonly code: WorkflowDiagnosticCode;
  readonly message: string;
  readonly path: WorkflowFieldPath;
  readonly stepId?: string;
  readonly range: WorkflowSourceRange;
}

export interface WorkflowDefinitionParseResult {
  readonly definition: WorkflowDefinition | null;
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

export interface WorkflowStepAdditionParseResult {
  readonly step: WorkflowStep | null;
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

export interface WorkflowStepAdditionOptions {
  /** A signal occurrence the caller already selected and verified in this run. */
  readonly evidence?: WorkflowSignalReference;
}

export interface WorkflowFieldEdit {
  /** Path of an existing scalar value in this exact version of the source. */
  readonly path: WorkflowFieldPath;
  readonly value: JsonPrimitive;
}

export interface WorkflowDefinitionEditResult extends WorkflowDefinitionParseResult {
  readonly source: string;
  /** When present, diagnostics refer to this rejected candidate, not source. */
  readonly attemptedSource?: string;
}
