import type {
  AgentIntegrationClass,
  AgentIntegration,
  AgentMigrationStore,
} from '@garcon/server-agent-interface';
import { validateAgentIntegration } from '@garcon/server-agent-interface/testing';
import { IntegrationHostFactory } from './integration-host.js';
import { AgentTypeRegistry } from './type-registry.js';

export interface IntegrationRegistryOptions {
  readonly integrations: readonly AgentIntegrationClass[];
  readonly executableAgentIds?: readonly string[];
  readonly hostFactory: IntegrationHostFactory;
  readonly migrationStoreFor: (agentId: string) => AgentMigrationStore;
}

interface IntegrationRecord {
  readonly integrationClass: AgentIntegrationClass;
  readonly integration: AgentIntegration;
}

export class IntegrationRegistry {
  readonly types: AgentTypeRegistry;
  readonly #records = new Map<string, IntegrationRecord>();
  readonly #migrationStoreFor: (agentId: string) => AgentMigrationStore;
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #started = false;

  constructor(options: IntegrationRegistryOptions) {
    const declarations = [...options.integrations].map((integrationClass) => ({
      integrationClass,
      integrationId: integrationClass.integrationId,
      apiVersion: integrationClass.apiVersion,
      descriptor: integrationClass.descriptor,
    }));
    this.types = new AgentTypeRegistry(declarations);
    const executableAgentIds = new Set(options.executableAgentIds ?? declarations.map((entry) => entry.integrationId));
    for (const agentId of executableAgentIds) this.types.require(agentId);
    this.#migrationStoreFor = options.migrationStoreFor;
    for (const { integrationClass, integrationId, apiVersion } of declarations) {
      if (!executableAgentIds.has(integrationId)) continue;
      const descriptor = this.types.require(integrationId);
      const host = options.hostFactory.forAgent(integrationId);
      const integration = new integrationClass(host);
      validateAgentIntegration({
        integrationClass: { integrationId, apiVersion, descriptor },
        integration,
      });
      const defaults = integration.settings.defaults();
      if (defaults.ownerId !== integrationId || !Number.isSafeInteger(defaults.schemaVersion) || defaults.schemaVersion < 1) {
        throw new Error(`Agent integration ${integrationId} returned invalid default settings`);
      }
      options.hostFactory.bindConfiguration(
        integrationId,
        descriptor.configuration.map((entry) => entry.key),
      );
      this.#records.set(integrationId, { integrationClass, integration });
    }
  }

  has(agentId: string): boolean {
    return this.#records.has(agentId);
  }

  get(agentId: string): AgentIntegration | null {
    return this.#records.get(agentId)?.integration ?? null;
  }

  require(agentId: string): AgentIntegration {
    const integration = this.get(agentId);
    if (!integration) throw new Error(`Unsupported agent integration: ${agentId}`);
    return integration;
  }

  list(): readonly AgentIntegration[] {
    return [...this.#records.values()].map((record) => record.integration);
  }

  classes(): readonly AgentIntegrationClass[] {
    return [...this.#records.values()].map((record) => record.integrationClass);
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    if (this.#stopPromise) throw new Error('Agent integrations are stopping');
    this.#startPromise = this.#startAll().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stopAll().finally(() => {
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }

  async #startAll(): Promise<void> {
    const started: AgentIntegration[] = [];
    try {
      for (const integration of this.list()) {
        await integration.lifecycle.migrateOwnedStorage(
          this.#migrationStoreFor(integration.descriptor.id),
        );
        await integration.lifecycle.start();
        started.push(integration);
      }
      this.#started = true;
    } catch (cause) {
      const rollback = await Promise.allSettled(
        started.reverse().map((integration) => integration.lifecycle.stop()),
      );
      const rollbackErrors = rollback
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [cause, ...rollbackErrors],
          'Agent integration startup failed and lifecycle rollback was incomplete',
        );
      }
      throw cause;
    }
  }

  async #stopAll(): Promise<void> {
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    if (!this.#started) return;
    this.#started = false;
    const stopped = await Promise.allSettled(
      [...this.list()].reverse().map((integration) => integration.lifecycle.stop()),
    );
    const errors = stopped
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'Agent integration shutdown failed');
  }
}
