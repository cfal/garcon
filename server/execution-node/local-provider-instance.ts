import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { ConfiguredAgentInstance } from '../../common/execution-nodes.js';
import type { ProviderInstanceRegistration, ProviderInstanceServices } from '../execution-nodes/provider-instance.js';
import { LocalProviderConfigurationService } from './local-provider-configuration.js';
import { LocalProviderCatalogService } from './local-provider-catalog.js';
import type { ProviderCatalogService } from '../execution-nodes/provider-catalog.js';
import { LocalProviderAuthService } from './local-provider-auth.js';
import type { ProviderAuthService } from '../execution-nodes/provider-auth.js';
import { LocalProviderCommandsService } from './local-provider-commands.js';
import type { ProviderCommandsService } from '../execution-nodes/provider-commands.js';
import { LocalProviderNativeSessionService } from './local-provider-native-sessions.js';
import type { ProviderNativeSessionService } from '../execution-nodes/provider-native-sessions.js';
import { LocalProviderNativeActivityService } from './local-provider-native-activity.js';
import type { ProviderNativeActivityService } from '../execution-nodes/provider-native-activity.js';
import { LocalProviderHistoryImportService } from './local-provider-history-import.js';
import type { ProviderHistoryImportService } from '../execution-nodes/provider-history-import.js';
import { LocalProviderNativeForkService } from './local-provider-native-fork.js';
import type { ProviderNativeForkService } from '../execution-nodes/provider-native-fork.js';
import { LocalProviderSingleQueryService } from './local-provider-single-query.js';
import type { ProviderSingleQueryService } from '../execution-nodes/provider-single-query.js';
import { LocalProviderTextGenerationService } from './local-provider-text-generation.js';
import type { ProviderTextGenerationService } from '../execution-nodes/provider-text-generation.js';
import { LocalProviderExecutionService } from './local-provider-execution.js';
import type { ProviderExecutionService } from '../execution-nodes/provider-execution.js';
import { LocalProviderProjectPathUpdateService } from './local-provider-project-path.js';
import type { ProviderProjectPathUpdateService } from '../execution-nodes/provider-project-path.js';
import { localProviderMetadata } from './local-provider-metadata.js';
import type { ProviderInstanceMetadata } from '../execution-nodes/provider-metadata.js';

export interface LocalProviderInstance {
  readonly configuration: ConfiguredAgentInstance;
  readonly integration: AgentIntegration;
}

const instanceBindings = new WeakMap<AgentIntegration, object>();

export function createLocalProviderInstances(instances: readonly LocalProviderInstance[]): readonly ProviderInstanceRegistration[] {
  const integrations = new Set<AgentIntegration>();
  return instances.map(({ configuration, integration }) => {
    if (integrations.has(integration)) throw new Error('Configured instances cannot share one executable integration');
    integrations.add(integration);
    return Object.freeze({ configuration: Object.freeze({ ...configuration }), services: new LocalProviderInstanceServices(integration) });
  });
}

class LocalProviderInstanceServices implements ProviderInstanceServices {
  readonly binding: object;
  readonly agentId: string;
  readonly #integration: AgentIntegration;
  #metadata: ProviderInstanceMetadata | undefined;
  #configuration: LocalProviderConfigurationService | undefined;
  #execution: ProviderExecutionService | undefined;
  #catalog: ProviderCatalogService | undefined;
  #auth: ProviderAuthService | undefined;
  #commands: ProviderCommandsService | undefined;
  #nativeSessions: ProviderNativeSessionService | undefined;
  #nativeActivity: ProviderNativeActivityService | undefined;
  #legacyHistoryImport: ProviderHistoryImportService | undefined;
  #nativeHistoryImport: ProviderHistoryImportService | undefined;
  #nativeFork: ProviderNativeForkService | undefined;
  #singleQuery: ProviderSingleQueryService | undefined;
  #textGeneration: ProviderTextGenerationService | undefined;
  #projectPathUpdates: ProviderProjectPathUpdateService | undefined;

  constructor(integration: AgentIntegration) {
    this.#integration = integration;
    this.agentId = integration.descriptor.id;
    let binding = instanceBindings.get(integration);
    if (!binding) {
      binding = Object.freeze({});
      instanceBindings.set(integration, binding);
    }
    this.binding = binding;
  }

  get metadata(): ProviderInstanceMetadata {
    return this.#metadata ??= localProviderMetadata(this.#integration);
  }

  get configuration(): LocalProviderConfigurationService {
    return this.#configuration ??= new LocalProviderConfigurationService(this.#integration);
  }

  get execution(): ProviderExecutionService {
    return this.#execution ??= new LocalProviderExecutionService(this.#integration, this.configuration);
  }

  get catalog(): ProviderCatalogService {
    return this.#catalog ??= new LocalProviderCatalogService(this.#integration);
  }

  get auth(): ProviderAuthService {
    return this.#auth ??= new LocalProviderAuthService(this.#integration);
  }

  get commands(): ProviderCommandsService {
    return this.#commands ??= new LocalProviderCommandsService(this.#integration);
  }

  get nativeSessions(): ProviderNativeSessionService {
    return this.#nativeSessions ??= new LocalProviderNativeSessionService(this.#integration);
  }

  get nativeActivity(): ProviderNativeActivityService | null {
    if (!this.#integration.nativeActivity) return null;
    return this.#nativeActivity ??= new LocalProviderNativeActivityService(this.#integration);
  }

  get legacyHistoryImport(): ProviderHistoryImportService | null {
    if (!this.#integration.legacyHistoryImport) return null;
    return this.#legacyHistoryImport ??= new LocalProviderHistoryImportService(this.#integration, this.#integration.legacyHistoryImport);
  }

  get nativeHistoryImport(): ProviderHistoryImportService | null {
    if (!this.#integration.nativeHistoryImport) return null;
    return this.#nativeHistoryImport ??= new LocalProviderHistoryImportService(this.#integration, this.#integration.nativeHistoryImport);
  }

  get nativeFork(): ProviderNativeForkService | null {
    if (!this.#integration.forking) return null;
    return this.#nativeFork ??= new LocalProviderNativeForkService(this.#integration, this.#integration.forking);
  }

  get singleQuery(): ProviderSingleQueryService | null {
    if (!this.#integration.singleQuery) return null;
    return this.#singleQuery ??= new LocalProviderSingleQueryService(this.#integration, this.#integration.singleQuery);
  }

  get textGeneration(): ProviderTextGenerationService | null {
    if (!this.#integration.textGeneration) return null;
    return this.#textGeneration ??= new LocalProviderTextGenerationService(this.#integration, this.#integration.textGeneration);
  }

  get projectPathUpdates(): ProviderProjectPathUpdateService | null {
    if (!this.#integration.projectPathUpdates) return null;
    return this.#projectPathUpdates ??= new LocalProviderProjectPathUpdateService(this.#integration, this.#integration.projectPathUpdates);
  }
}
