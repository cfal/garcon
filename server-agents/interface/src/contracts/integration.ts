import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type { AgentExecution } from './execution.js';
import type { AgentHost } from './host.js';
import type {
  AgentAuth,
  AgentCatalog,
  AgentCommands,
  AgentEndpoints,
  AgentForking,
  AgentLifecycle,
  AgentMigration,
  AgentSettings,
  AgentSingleQuery,
} from './services.js';
import type { AgentTranscriptIndexModuleReference } from './transcript-index.js';
import type { AgentTranscript } from './transcript.js';

export interface AgentIntegration {
  readonly descriptor: AgentDescriptor;
  readonly execution: AgentExecution;
  readonly transcript: AgentTranscript;
  readonly catalog: AgentCatalog;
  readonly settings: AgentSettings;
  readonly lifecycle: AgentLifecycle;
  readonly migration: AgentMigration;
  readonly auth: AgentAuth | null;
  readonly commands: AgentCommands | null;
  readonly forking: AgentForking | null;
  readonly endpoints: AgentEndpoints | null;
  readonly singleQuery: AgentSingleQuery | null;
}

export interface AgentIntegrationClass {
  new (host: AgentHost): AgentIntegration;
  readonly integrationId: string;
  readonly apiVersion: 2;
  readonly transcriptIndex: AgentTranscriptIndexModuleReference;
}
