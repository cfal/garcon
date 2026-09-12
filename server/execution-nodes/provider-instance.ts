import type { ConfiguredAgentInstance } from '../../common/execution-nodes.js';
import type { ProviderAuthService } from './provider-auth.js';
import type { ProviderCatalogService } from './provider-catalog.js';
import type { ProviderCommandsService } from './provider-commands.js';
import type { ProviderConfigurationService } from './provider-configuration.js';
import type { ProviderExecutionService } from './provider-execution.js';
import type { ProviderHistoryImportService } from './provider-history-import.js';
import type { ProviderInstanceMetadata } from './provider-metadata.js';
import type { ProviderNativeActivityService } from './provider-native-activity.js';
import type { ProviderNativeForkService } from './provider-native-fork.js';
import type { ProviderNativeSessionService } from './provider-native-sessions.js';
import type { ProviderProjectPathUpdateService } from './provider-project-path.js';
import type { ProviderSingleQueryService } from './provider-single-query.js';
import type { ProviderTextGenerationService } from './provider-text-generation.js';

/** Supplies instance-bound ports and cached metadata without initiating provider I/O. */
export interface ProviderInstanceServices {
  /** Identifies one native owner; wrappers and repeated registrations retain this opaque identity. */
  readonly binding: object;
  readonly agentId: string;
  readonly metadata: ProviderInstanceMetadata;
  readonly configuration: ProviderConfigurationService;
  readonly execution: ProviderExecutionService;
  readonly catalog: ProviderCatalogService;
  readonly auth: ProviderAuthService;
  readonly commands: ProviderCommandsService;
  readonly nativeSessions: ProviderNativeSessionService;
  readonly nativeActivity: ProviderNativeActivityService | null;
  readonly legacyHistoryImport: ProviderHistoryImportService | null;
  readonly nativeHistoryImport: ProviderHistoryImportService | null;
  readonly nativeFork: ProviderNativeForkService | null;
  readonly singleQuery: ProviderSingleQueryService | null;
  readonly textGeneration: ProviderTextGenerationService | null;
  readonly projectPathUpdates: ProviderProjectPathUpdateService | null;
}

export interface ProviderInstanceRegistration {
  readonly configuration: ConfiguredAgentInstance;
  readonly services: ProviderInstanceServices;
}
