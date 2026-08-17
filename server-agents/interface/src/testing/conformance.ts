import { isDeepStrictEqual } from 'node:util';
import type {
  AgentIntegrationClass,
  AgentIntegration,
} from '../index.js';

const REQUIRED_FACET_METHODS = {
  execution: ['start', 'resume', 'abort', 'runningSessions'],
  catalog: ['snapshot'],
  settings: ['describe', 'defaults', 'parse', 'migrate', 'applyPatch'],
  lifecycle: ['start', 'stop', 'migrateOwnedStorage'],
  migration: ['translateLegacyNativeSession', 'translateLegacySettings'],
} as const;

const NULLABLE_FACET_METHODS = {
  auth: ['status'],
  commands: ['discover'],
  compaction: ['compact'],
  forking: ['fork', 'discard'],
  steering: ['captureTarget', 'steer'],
  goals: ['submitControl'],
  endpoints: ['validate'],
  singleQuery: ['run'],
  legacyHistoryImport: ['load'],
  nativeHistoryImport: ['load'],
  nativeActivity: ['lastActivity'],
  nativeSessions: ['resolveNativeSession', 'describeSource', 'release'],
  sessionConfiguration: ['apply'],
  projectPathUpdates: ['prepare'],
} as const;

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
  const integrationRecord = integration as unknown as Record<string, unknown>;
  const agentId = integration.descriptor?.id ?? integrationClass.integrationId;
  if (integrationClass.apiVersion !== 5) {
    throw new Error(`Unsupported agent integration API version: ${integrationClass.apiVersion}`);
  }
  if (integrationClass.integrationId !== integration.descriptor.id) {
    throw new Error(
      `Agent integration ID mismatch: ${integrationClass.integrationId} != ${integration.descriptor.id}`,
    );
  }
  for (const [facet, methods] of Object.entries(REQUIRED_FACET_METHODS)) {
    assertFacetMethods(agentId, facet, integrationRecord[facet], methods);
  }
  assertAttachmentsFacet(agentId, integrationRecord);
  for (const [facet, methods] of Object.entries(NULLABLE_FACET_METHODS)) {
    if (!(facet in integrationRecord) || integrationRecord[facet] === undefined) {
      throw new Error(`Agent integration ${agentId} is missing required ${facet} capability state`);
    }
    const value = integrationRecord[facet];
    if (value !== null) assertFacetMethods(agentId, facet, value, methods);
  }
  assertOptionalMethods(agentId, 'auth', integrationRecord.auth, [
    'launchLogin',
    'completeLogin',
    'loginStatus',
  ]);
  assertSingleQueryOptions(agentId, integrationRecord.singleQuery);
  if ('transcriptSearch' in integration) {
    throw new Error(`Agent integration ${agentId} exposes removed transcriptSearch state`);
  }
  if ('submitActiveInput' in integration.execution) {
    throw new Error(`Agent integration ${agentId} exposes removed execution.submitActiveInput`);
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

function assertFacetMethods(
  agentId: string,
  facet: string,
  value: unknown,
  methods: readonly string[],
): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`Agent integration ${agentId} has an invalid ${facet} facet`);
  }
  const record = value as Record<string, unknown>;
  if (methods.some((method) => typeof record[method] !== 'function')) {
    throw new Error(`Agent integration ${agentId} has an invalid ${facet} facet`);
  }
}

function assertAttachmentsFacet(
  agentId: string,
  integration: Record<string, unknown>,
): void {
  if (!('attachments' in integration) || integration.attachments === undefined) {
    throw new Error(`Agent integration ${agentId} is missing required attachments capability state`);
  }
  if (integration.attachments === null) return;
  if (!integration.attachments || typeof integration.attachments !== 'object') {
    throw new Error(`Agent integration ${agentId} has an invalid attachments facet`);
  }
  const fileMimeTypes = (integration.attachments as Record<string, unknown>).fileMimeTypes;
  if (!Array.isArray(fileMimeTypes) || fileMimeTypes.some((value) => typeof value !== 'string')) {
    throw new Error(`Agent integration ${agentId} has an invalid attachments facet`);
  }
}

function assertOptionalMethods(
  agentId: string,
  facet: string,
  value: unknown,
  methods: readonly string[],
): void {
  if (value === null || value === undefined) return;
  const record = value as Record<string, unknown>;
  if (methods.some((method) => (
    method in record && record[method] !== undefined && typeof record[method] !== 'function'
  ))) {
    throw new Error(`Agent integration ${agentId} has an invalid ${facet} facet`);
  }
}

function assertSingleQueryOptions(agentId: string, value: unknown): void {
  if (value === null || value === undefined) return;
  const record = value as Record<string, unknown>;
  if (
    'runsToolsWithoutPermission' in record
    && record.runsToolsWithoutPermission !== true
  ) {
    throw new Error(`Agent integration ${agentId} has an invalid singleQuery facet`);
  }
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
  const migratedSnapshot = structuredClone(migrated);
  const migratedAgain = await integration.settings.migrate(migrated);
  assertSettingsEnvelope(agentId, migrated);
  assertSettingsEnvelope(agentId, migratedAgain);
  if (!isDeepStrictEqual(migratedAgain, migratedSnapshot)) {
    throw new Error(`Agent integration ${agentId} settings migration is not idempotent`);
  }
  const patchInputSnapshot = structuredClone(migrated);
  const patched = integration.settings.applyPatch(migrated, {});
  assertSettingsEnvelope(agentId, patched);
  if (
    !isDeepStrictEqual(patched, patchInputSnapshot)
    || !isDeepStrictEqual(migrated, patchInputSnapshot)
  ) {
    throw new Error(`Agent integration ${agentId} changed settings for an empty patch`);
  }

  let started = false;
  try {
    await integration.lifecycle.start();
    started = true;
    await integration.lifecycle.start();
    assertRunningSessions(agentId, integration.execution.runningSessions());
  } finally {
    if (started) {
      await integration.lifecycle.stop();
      await integration.lifecycle.stop();
    }
  }
}

function assertRunningSessions(agentId: string, value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error(`Agent integration ${agentId} returned an invalid running session snapshot`);
  }
  const seen = new Set<string>();
  for (const session of value) {
    if (!session || typeof session !== 'object') {
      throw new Error(`Agent integration ${agentId} returned an invalid running session snapshot`);
    }
    const record = session as Record<string, unknown>;
    if (
      typeof record.agentSessionId !== 'string'
      || record.agentSessionId.length === 0
      || (record.status !== null && typeof record.status !== 'string')
      || (record.startedAt !== null && typeof record.startedAt !== 'string')
      || seen.has(record.agentSessionId)
    ) {
      throw new Error(`Agent integration ${agentId} returned an invalid running session snapshot`);
    }
    seen.add(record.agentSessionId);
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
