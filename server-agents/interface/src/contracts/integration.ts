import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type { AgentHost } from './host.js';
import type {
  AgentAuth,
  AgentAttachments,
  AgentCatalog,
  AgentCommands,
  AgentEndpoints,
  AgentCompactionV4,
  AgentGoalsV4,
  AgentLifecycle,
  AgentMigration,
  AgentSettings,
  AgentSingleQuery,
  AgentSteeringV4,
} from './services.js';
import type { AgentNativeFork } from './native-fork.js';
import type { AgentTranscriptIndexModuleReference } from './transcript-index.js';
import type { AgentTranscriptIndexerModuleV4 } from './transcript-index-v4.js';
import type { AgentExecutionV4 } from './execution-events-v4.js';
import type { AgentExecutionV5 } from './execution-v5.js';
import type {
  AgentNativeActivityProbe,
  AgentNativeHistoryImport,
} from './native-history.js';
import type {
  AgentTranscriptStream,
  AgentTransientControlCapabilityV4,
} from './transcript-stream-v4.js';

export interface AgentIntegrationV4 {
  readonly descriptor: AgentDescriptor;
  readonly attachments: AgentAttachments | null;
  readonly execution: AgentExecutionV4;
  readonly transcript: AgentTranscriptStream;
  readonly catalog: AgentCatalog;
  readonly settings: AgentSettings;
  readonly lifecycle: AgentLifecycle;
  readonly migration: AgentMigration;
  readonly auth: AgentAuth | null;
  readonly commands: AgentCommands | null;
  readonly compaction: AgentCompactionV4 | null;
  readonly forking: AgentNativeFork | null;
  readonly steering: AgentSteeringV4 | null;
  readonly goals: AgentGoalsV4 | null;
  readonly endpoints: AgentEndpoints | null;
  readonly singleQuery: AgentSingleQuery | null;
  readonly transientControls: AgentTransientControlCapabilityV4 | null;
  // Transitional V5 facets remain inactive until core switches serving authority.
  readonly producerExecution: AgentExecutionV5;
  readonly nativeHistoryImport: AgentNativeHistoryImport | null;
  readonly nativeActivity: AgentNativeActivityProbe | null;
}

export interface AgentIntegrationClassV4 {
  new (host: AgentHost): AgentIntegrationV4;
  readonly integrationId: string;
  readonly apiVersion: 4;
  readonly transcriptIndex: AgentTranscriptIndexModuleReference & Pick<AgentTranscriptIndexerModuleV4, 'apiVersion'>;
}
