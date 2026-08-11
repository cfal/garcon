import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type { AgentExecution } from './execution.js';
import type { AgentHost } from './host.js';
import type {
  AgentAuth,
  AgentAttachments,
  AgentCatalog,
  AgentCommands,
  AgentEndpoints,
  AgentCompaction,
  AgentCompactionV4,
  AgentForking,
  AgentGoals,
  AgentGoalsV4,
  AgentLifecycle,
  AgentMigration,
  AgentSettings,
  AgentSingleQuery,
  AgentSteering,
  AgentSteeringV4,
} from './services.js';
import type { AgentTranscriptIndexModuleReference } from './transcript-index.js';
import type { AgentTranscript } from './transcript.js';
import type { AgentExecutionV4 } from './execution-events-v4.js';
import type {
  AgentTranscriptStream,
  AgentTransientControlCapabilityV4,
} from './transcript-stream-v4.js';

export interface AgentIntegration {
  readonly descriptor: AgentDescriptor;
  readonly attachments: AgentAttachments | null;
  readonly execution: AgentExecution;
  readonly transcript: AgentTranscript;
  readonly catalog: AgentCatalog;
  readonly settings: AgentSettings;
  readonly lifecycle: AgentLifecycle;
  readonly migration: AgentMigration;
  readonly auth: AgentAuth | null;
  readonly commands: AgentCommands | null;
  readonly compaction: AgentCompaction | null;
  readonly forking: AgentForking | null;
  readonly steering: AgentSteering | null;
  readonly goals: AgentGoals | null;
  readonly endpoints: AgentEndpoints | null;
  readonly singleQuery: AgentSingleQuery | null;
}

export interface AgentIntegrationClass {
  new (host: AgentHost): AgentIntegration;
  readonly integrationId: string;
  readonly apiVersion: 3;
  readonly transcriptIndex: AgentTranscriptIndexModuleReference;
}

export interface AgentIntegrationV4
  extends Omit<AgentIntegration, 'execution' | 'transcript' | 'compaction' | 'steering' | 'goals'> {
  readonly execution: AgentExecutionV4;
  readonly transcript: AgentTranscriptStream;
  readonly compaction: AgentCompactionV4 | null;
  readonly steering: AgentSteeringV4 | null;
  readonly goals: AgentGoalsV4 | null;
  readonly transientControls: AgentTransientControlCapabilityV4 | null;
}

export interface AgentIntegrationClassV4 {
  new (host: AgentHost): AgentIntegrationV4;
  readonly integrationId: string;
  readonly apiVersion: 4;
  readonly transcriptIndex: AgentTranscriptIndexModuleReference;
}
