import type {
  AgentIntegrationClass,
  AgentIntegration,
} from '../index.js';

export interface AgentIntegrationConformanceOptions {
  readonly integrationClass: Pick<
    AgentIntegrationClass,
    'integrationId' | 'apiVersion'
  >;
  readonly integration: AgentIntegration;
}

export function validateAgentIntegration(
  options: AgentIntegrationConformanceOptions,
): void {
  const { integration, integrationClass } = options;
  if (integrationClass.apiVersion !== 5) {
    throw new Error(`Unsupported agent integration API version: ${integrationClass.apiVersion}`);
  }
  if (integrationClass.integrationId !== integration.descriptor.id) {
    throw new Error(
      `Agent integration ID mismatch: ${integrationClass.integrationId} != ${integration.descriptor.id}`,
    );
  }
  if (!integration.execution) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing a required facet`);
  }
  if (typeof integration.execution.start !== 'function'
      || typeof integration.execution.resume !== 'function'
      || typeof integration.execution.abort !== 'function') {
    throw new Error(`Agent integration ${integration.descriptor.id} has an invalid execution facet`);
  }
  for (const facet of [
    'nativeHistoryImport',
    'nativeActivity',
    'nativeSessions',
    'sessionConfiguration',
    'permissionDecisions',
    'projectPathUpdates',
  ] as const) {
    if (!(facet in integration) || integration[facet] === undefined) {
      throw new Error(`Agent integration ${integration.descriptor.id} is missing required ${facet} capability state`);
    }
  }
  if ('transcriptSearch' in integration) {
    throw new Error(`Agent integration ${integration.descriptor.id} exposes removed transcriptSearch state`);
  }
  if (!integration.catalog || !integration.settings || !integration.lifecycle || !integration.migration) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing a required service facet`);
  }
  for (const facet of ['steering', 'goals'] as const) {
    if (!(facet in integration) || integration[facet] === undefined) {
      throw new Error(`Agent integration ${integration.descriptor.id} is missing required ${facet} capability state`);
    }
  }
  if (
    integration.steering !== null
    && (
      typeof integration.steering.captureTarget !== 'function'
      || typeof integration.steering.steer !== 'function'
    )
  ) {
    throw new Error(`Agent integration ${integration.descriptor.id} has an invalid steering facet`);
  }
  if (integration.goals !== null && typeof integration.goals.submitControl !== 'function') {
    throw new Error(`Agent integration ${integration.descriptor.id} has an invalid goals facet`);
  }
  if ('submitActiveInput' in integration.execution) {
    throw new Error(`Agent integration ${integration.descriptor.id} exposes removed execution.submitActiveInput`);
  }
  assertUniqueDescriptorValues(
    integration.descriptor.id,
    'permission modes',
    integration.descriptor.supportedPermissionModes,
  );
  assertUniqueDescriptorValues(
    integration.descriptor.id,
    'thinking modes',
    integration.descriptor.supportedThinkingModes,
  );
  assertUniqueDescriptorValues(
    integration.descriptor.id,
    'endpoint protocols',
    integration.descriptor.supportedEndpointProtocols,
  );
}

function assertUniqueDescriptorValues(
  agentId: string,
  label: string,
  values: readonly string[],
): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Agent integration ${agentId} declares duplicate ${label}`);
  }
}

export async function runAgentIntegrationConformance(
  options: AgentIntegrationConformanceOptions,
): Promise<void> {
  validateAgentIntegration(options);
  const { integration } = options;
  const agentId = integration.descriptor.id;
  const descriptors = integration.settings.describe();
  const descriptorKeys = new Set(descriptors.map((descriptor) => descriptor.key));
  if (descriptorKeys.size !== descriptors.length) {
    throw new Error(`Agent integration ${agentId} declares duplicate setting keys`);
  }

  const defaults = integration.settings.defaults();
  assertSettingsEnvelope(agentId, defaults);
  for (const key of Object.keys(defaults.values)) {
    if (!descriptorKeys.has(key)) {
      throw new Error(`Agent integration ${agentId} has an undescribed default setting: ${key}`);
    }
  }
  const parsed = integration.settings.parse(defaults);
  assertSettingsEnvelope(agentId, parsed);
  const migrated = await integration.settings.migrate(parsed);
  const migratedAgain = await integration.settings.migrate(migrated);
  assertSettingsEnvelope(agentId, migrated);
  assertSettingsEnvelope(agentId, migratedAgain);
  if (JSON.stringify(migratedAgain) !== JSON.stringify(migrated)) {
    throw new Error(`Agent integration ${agentId} settings migration is not idempotent`);
  }

  const signal = new AbortController().signal;
  let started = false;
  try {
    await integration.lifecycle.start();
    started = true;
    await integration.lifecycle.start();
  } finally {
    if (started) {
      await integration.lifecycle.stop();
      await integration.lifecycle.stop();
    }
  }
}

function assertSettingsEnvelope(
  agentId: string,
  value: ReturnType<AgentIntegration['settings']['defaults']>,
): void {
  if (
    value.ownerId !== agentId
    || !Number.isSafeInteger(value.schemaVersion)
    || value.schemaVersion < 1
    || !value.values
    || typeof value.values !== 'object'
    || Array.isArray(value.values)
  ) {
    throw new Error(`Agent integration ${agentId} returned an invalid settings envelope`);
  }
}
