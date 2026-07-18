import type {
  AgentIntegration,
  AgentIntegrationClass,
  AgentMigrationStore,
} from '@garcon/server-agent-interface';
import { validateAgentIntegration } from '@garcon/server-agent-interface/testing';
import { IntegrationHostFactory } from './integration-host.js';

export interface IntegrationRegistryOptions {
  readonly integrations: readonly AgentIntegrationClass[];
  readonly hostFactory: IntegrationHostFactory;
  readonly migrationStoreFor: (agentId: string) => AgentMigrationStore;
}

interface IntegrationRecord {
  readonly integrationClass: AgentIntegrationClass;
  readonly integration: AgentIntegration;
}

export class IntegrationRegistry {
  readonly #records = new Map<string, IntegrationRecord>();
  readonly #migrationStoreFor: (agentId: string) => AgentMigrationStore;
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #started = false;

  constructor(options: IntegrationRegistryOptions) {
    this.#migrationStoreFor = options.migrationStoreFor;
    for (const integrationClass of options.integrations) {
      validateClass(integrationClass, this.#records);
      const host = options.hostFactory.forAgent(integrationClass.integrationId);
      const integration = new integrationClass(host);
      validateAgentIntegration({ integrationClass, integration });
      validateDescriptor(integration);
      options.hostFactory.bindConfiguration(
        integration.descriptor.id,
        integration.descriptor.configuration.map((entry) => entry.key),
      );
      this.#records.set(integration.descriptor.id, { integrationClass, integration });
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

function validateClass(
  integrationClass: AgentIntegrationClass,
  existing: ReadonlyMap<string, IntegrationRecord>,
): void {
  if (integrationClass.apiVersion !== 1) {
    throw new Error(
      `Unsupported agent integration API version for ${integrationClass.integrationId}: ${integrationClass.apiVersion}`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(integrationClass.integrationId)) {
    throw new Error(`Invalid agent integration ID: ${integrationClass.integrationId}`);
  }
  if (existing.has(integrationClass.integrationId)) {
    throw new Error(`Duplicate agent integration ID: ${integrationClass.integrationId}`);
  }
}

function validateDescriptor(integration: AgentIntegration): void {
  const { descriptor } = integration;
  if (!descriptor.label.trim()) throw new Error(`Agent integration ${descriptor.id} has an empty label`);
  const configurationKeys = new Set<string>();
  for (const entry of descriptor.configuration) {
    if (!entry.key.trim() || entry.source !== 'environment') {
      throw new Error(`Agent integration ${descriptor.id} has an invalid configuration descriptor`);
    }
    if (configurationKeys.has(entry.key)) {
      throw new Error(`Agent integration ${descriptor.id} declares configuration ${entry.key} twice`);
    }
    configurationKeys.add(entry.key);
  }
  const defaults = integration.settings.defaults();
  if (defaults.ownerId !== descriptor.id || defaults.schemaVersion < 1) {
    throw new Error(`Agent integration ${descriptor.id} returned invalid default settings`);
  }
}
