import type {
  AgentIntegrationClass,
  AgentIntegration,
} from '@garcon/server-agent-interface';
import { validateAgentIntegration } from '@garcon/server-agent-interface/testing';
import { IntegrationHostFactory } from './integration-host.js';

export interface LocalIntegrationRegistryOptions {
  readonly integrations: readonly AgentIntegrationClass[];
  readonly hostFactory: IntegrationHostFactory;
}

export type IntegrationRegistryOptions = LocalIntegrationRegistryOptions | {
  readonly instances: readonly AgentIntegration[];
};

export class IntegrationRegistry {
  readonly #integrations = new Map<string, AgentIntegration>();
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #started = false;

  constructor(options: IntegrationRegistryOptions) {
    if ('instances' in options) {
      for (const integration of options.instances) {
        const integrationId = integration.descriptor.id;
        if (this.#integrations.has(integrationId)) throw new Error(`Duplicate agent integration ID: ${integrationId}`);
        validateAgentIntegration({ integrationClass: { integrationId, apiVersion: 5 }, integration });
        validateDescriptor(integration);
        this.#integrations.set(integrationId, integration);
      }
      return;
    }
    for (const integrationClass of options.integrations) {
      validateClass(integrationClass, this.#integrations);
      const host = options.hostFactory.forAgent(integrationClass.integrationId);
      const integration = new integrationClass(host);
      validateAgentIntegration({ integrationClass, integration });
      validateDescriptor(integration);
      options.hostFactory.bindConfiguration(
        integration.descriptor.id,
        integration.descriptor.configuration.map((entry) => entry.key),
      );
      this.#integrations.set(integration.descriptor.id, integration);
    }
  }

  has(agentId: string): boolean {
    return this.#integrations.has(agentId);
  }

  get(agentId: string): AgentIntegration | null {
    return this.#integrations.get(agentId) ?? null;
  }

  require(agentId: string): AgentIntegration {
    const integration = this.get(agentId);
    if (!integration) throw new Error(`Unsupported agent integration: ${agentId}`);
    return integration;
  }

  list(): readonly AgentIntegration[] {
    return [...this.#integrations.values()];
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
        await integration.lifecycle.migrateOwnedStorage();
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
  existing: ReadonlyMap<string, AgentIntegration>,
): void {
  if (integrationClass.apiVersion !== 5) {
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
