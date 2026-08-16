import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type { AgentHost } from './host.js';
import type {
  AgentAuth,
  AgentAttachments,
  AgentCatalog,
  AgentCommands,
  AgentEndpoints,
  AgentCompaction,
  AgentGoals,
  AgentLifecycle,
  AgentMigration,
  AgentSettings,
  AgentSingleQuery,
  AgentSteering,
} from './services.js';
import type { AgentNativeFork } from './native-fork.js';
import type {
  AgentProjectPathUpdates,
  AgentSessionConfigurationUpdates,
} from './execution.js';
import type { AgentExecutionV5 } from './execution-v5.js';
import type {
  AgentHistoryImport,
  AgentNativeActivityProbe,
  AgentNativeSessionAccess,
} from './native-history.js';

export interface AgentIntegration {
  readonly descriptor: AgentDescriptor;
  readonly attachments: AgentAttachments | null;
  readonly execution: AgentExecutionV5;
  readonly catalog: AgentCatalog;
  readonly settings: AgentSettings;
  readonly lifecycle: AgentLifecycle;
  readonly migration: AgentMigration;
  readonly auth: AgentAuth | null;
  readonly commands: AgentCommands | null;
  readonly compaction: AgentCompaction | null;
  readonly forking: AgentNativeFork | null;
  readonly steering: AgentSteering | null;
  readonly goals: AgentGoals | null;
  readonly endpoints: AgentEndpoints | null;
  readonly singleQuery: AgentSingleQuery | null;
  readonly legacyHistoryImport: AgentHistoryImport | null;
  readonly nativeHistoryImport: AgentHistoryImport | null;
  readonly nativeActivity: AgentNativeActivityProbe | null;
  readonly nativeSessions: AgentNativeSessionAccess | null;
  readonly sessionConfiguration: AgentSessionConfigurationUpdates | null;
  readonly projectPathUpdates: AgentProjectPathUpdates | null;
}

export interface AgentIntegrationClass {
  new (host: AgentHost): AgentIntegration;
  readonly integrationId: string;
  readonly apiVersion: 5;
}
