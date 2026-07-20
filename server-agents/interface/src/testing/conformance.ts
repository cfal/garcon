import type {
  AgentLogger,
  AgentIntegration,
  AgentIntegrationClass,
  AgentTranscriptIndexerModule,
} from '../index.js';

export interface AgentIntegrationConformanceOptions {
  readonly integrationClass: Pick<
    AgentIntegrationClass,
    'integrationId' | 'apiVersion' | 'transcriptIndex'
  >;
  readonly integration: AgentIntegration;
}

export function validateAgentIntegration(
  options: AgentIntegrationConformanceOptions,
): void {
  const { integration, integrationClass } = options;
  if (integrationClass.apiVersion !== 2) {
    throw new Error(`Unsupported agent integration API version: ${integrationClass.apiVersion}`);
  }
  if (integrationClass.integrationId !== integration.descriptor.id) {
    throw new Error(
      `Agent integration ID mismatch: ${integrationClass.integrationId} != ${integration.descriptor.id}`,
    );
  }
  if (!integration.execution || !integration.transcript) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing a required facet`);
  }
  if ('transcriptSearch' in integration) {
    throw new Error(`Agent integration ${integration.descriptor.id} exposes removed transcriptSearch state`);
  }
  if (integrationClass.transcriptIndex.apiVersion !== 1
      || !integrationClass.transcriptIndex.moduleUrl) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing its transcript index module`);
  }
  for (const method of ['resolveIndexSource', 'refreshIndexSource', 'describeSource'] as const) {
    if (typeof integration.transcript[method] !== 'function') {
      throw new Error(`Agent integration ${integration.descriptor.id} is missing transcript.${method}`);
    }
  }
  if (!integration.catalog || !integration.settings || !integration.lifecycle || !integration.migration) {
    throw new Error(`Agent integration ${integration.descriptor.id} is missing a required service facet`);
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

export async function runAgentTranscriptIndexerConformance(options: {
  readonly integrationId: string;
  readonly moduleUrl: string;
  readonly logger: AgentLogger;
}): Promise<void> {
  const imported = await import(options.moduleUrl) as { default?: unknown };
  const module = imported.default as Partial<AgentTranscriptIndexerModule> | undefined;
  if (!module || module.apiVersion !== 1 || module.integrationId !== options.integrationId
      || typeof module.create !== 'function') {
    throw new Error(`Agent integration ${options.integrationId} has an invalid transcript index module`);
  }
  const source = module.create({ agentId: options.integrationId, logger: options.logger });
  if (!source || typeof source.probe !== 'function'
      || typeof source.load !== 'function' || typeof source.close !== 'function') {
    throw new Error(`Agent integration ${options.integrationId} has an invalid transcript index source`);
  }
  await source.close();
  await source.close();
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
