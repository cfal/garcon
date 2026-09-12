import { isDeepStrictEqual } from 'node:util';
import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type {
  AgentIntegrationDefinition,
  AgentIntegration,
} from '../index.js';

const REQUIRED_FACET_METHODS = {
  execution: ['start', 'resume', 'abort', 'runningSessions'],
  catalog: ['snapshot'],
  settings: ['describe', 'defaults', 'parse', 'migrate', 'applyPatch'],
  lifecycle: ['start', 'stop', 'migrateOwnedStorage'],
  migration: ['translateLegacyModel', 'translateLegacyNativeSession', 'translateLegacySettings'],
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
  textGeneration: ['run'],
  legacyHistoryImport: ['load'],
  nativeHistoryImport: ['load'],
  nativeActivity: ['lastActivity'],
  nativeSessions: ['resolveNativeSession', 'describeSource', 'release'],
  sessionConfiguration: ['prepare', 'commit', 'cancel'],
  projectPathUpdates: ['prepare'],
} as const;

export interface AgentIntegrationConformanceOptions {
  readonly integrationClass: AgentIntegrationDefinition;
  readonly integration: AgentIntegration;
}

export function validateAgentIntegrationDefinition(definition: AgentIntegrationDefinition): void {
  if (definition.apiVersion !== 5) {
    throw new Error(`Unsupported agent integration API version for ${definition.integrationId}: ${definition.apiVersion}`);
  }
  if (typeof definition.integrationId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(definition.integrationId)) {
    throw new Error(`Invalid agent integration ID: ${definition.integrationId}`);
  }
  if (definition.integrationId !== definition.descriptor?.id) {
    throw new Error(`Agent integration ID mismatch: ${definition.integrationId} != ${definition.descriptor?.id}`);
  }
  validateDescriptor(definition.descriptor);
}

export function validateAgentIntegration(
  options: AgentIntegrationConformanceOptions,
): void {
  const { integration, integrationClass } = options;
  validateAgentIntegrationDefinition(integrationClass);
  const integrationRecord = integration as unknown as Record<string, unknown>;
  const agentId = integration.descriptor?.id ?? integrationClass.integrationId;
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
  validateDescriptor(integration.descriptor);
  if (!isDeepStrictEqual(integration.descriptor, integrationClass.descriptor)) {
    throw new Error(`Agent integration ${agentId} descriptor does not match its declaration`);
  }
}

function validateDescriptor(descriptor: AgentDescriptor): void {
  const id = descriptor.id;
  if (typeof descriptor.label !== 'string' || !descriptor.label.trim()) throw new Error(`Agent integration ${id} has an empty label`);
  if (descriptor.icon !== null && typeof descriptor.icon !== 'string'
    || typeof descriptor.supportsImages !== 'boolean'
    || typeof descriptor.supportsProjectPathUpdate !== 'boolean'
    || typeof descriptor.requiresNativePathForProjectPathUpdate !== 'boolean') {
    throw new Error(`Agent integration ${id} has an invalid descriptor`);
  }
  if (!Array.isArray(descriptor.configuration)) throw new Error(`Agent integration ${id} has invalid configuration`);
  const configurationKeys = new Set<string>();
  for (const entry of descriptor.configuration) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.trim() || entry.source !== 'environment'
      || typeof entry.description !== 'string') {
      throw new Error(`Agent integration ${id} has an invalid configuration descriptor`);
    }
    if (configurationKeys.has(entry.key)) throw new Error(`Agent integration ${id} declares configuration ${entry.key} twice`);
    configurationKeys.add(entry.key);
  }
  assertUniqueDescriptorValues(id, 'permission modes', descriptor.supportedPermissionModes);
  assertUniqueDescriptorValues(id, 'thinking modes', descriptor.supportedThinkingModes);
  assertUniqueDescriptorValues(id, 'endpoint protocols', descriptor.supportedEndpointProtocols);
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
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error(`Agent integration ${agentId} declares invalid ${label}`);
  }
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
