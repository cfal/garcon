import type {
  AgentSettingDescriptor,
  AgentSettingsEnvelope,
} from '@garcon/common/agent-integration';
import type { JsonObject } from '@garcon/common/json';
import {
  AgentIntegrationError,
  type AgentSettings,
} from '@garcon/server-agent-interface';

export interface VersionedSettingsOptions {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly descriptors: readonly AgentSettingDescriptor[];
  readonly defaults: JsonObject;
  readonly migrateValues?: (
    fromVersion: number,
    values: JsonObject,
  ) => Promise<JsonObject>;
}

export function createVersionedSettings(
  options: VersionedSettingsOptions,
): AgentSettings {
  const envelope = (values: JsonObject): AgentSettingsEnvelope => ({
    ownerId: options.ownerId,
    schemaVersion: options.schemaVersion,
    values: { ...values },
  });
  const parseCurrent = (input: AgentSettingsEnvelope): AgentSettingsEnvelope => {
    if (input.ownerId !== options.ownerId || input.schemaVersion !== options.schemaVersion) {
      throw invalidSettings(options.ownerId);
    }
    return envelope(validateSettingValues(input.values, options.descriptors));
  };

  return {
    describe: () => options.descriptors,
    defaults: () => envelope(validateSettingValues(options.defaults, options.descriptors)),
    parse: parseCurrent,
    async migrate(input) {
      if (input.ownerId !== options.ownerId || input.schemaVersion < 1) {
        throw invalidSettings(options.ownerId);
      }
      if (input.schemaVersion === options.schemaVersion) return parseCurrent(input);
      if (input.schemaVersion > options.schemaVersion || !options.migrateValues) {
        throw invalidSettings(options.ownerId);
      }
      const values = await options.migrateValues(input.schemaVersion, input.values);
      return envelope(validateSettingValues(values, options.descriptors));
    },
    applyPatch(current, patch) {
      const parsed = parseCurrent(current);
      return envelope(validateSettingValues(
        { ...parsed.values, ...patch },
        options.descriptors,
      ));
    },
  };
}

function validateSettingValues(
  values: JsonObject,
  descriptors: readonly AgentSettingDescriptor[],
): JsonObject {
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  for (const [key, value] of Object.entries(values)) {
    const descriptor = byKey.get(key);
    if (!descriptor) {
      throw new AgentIntegrationError('INVALID_SETTINGS', `Unknown setting ${key}`, false);
    }
    const valid = descriptor.type === 'boolean'
      ? typeof value === 'boolean'
      : descriptor.type === 'number'
        ? typeof value === 'number'
          && Number.isFinite(value)
          && value >= descriptor.min
          && value <= descriptor.max
        : descriptor.type === 'enum'
          ? typeof value === 'string'
            && descriptor.options.some((option) => option.value === value)
          : typeof value === 'string';
    if (!valid) {
      throw new AgentIntegrationError(
        'INVALID_SETTINGS',
        `Invalid value for setting ${key}`,
        false,
      );
    }
  }
  return { ...values };
}

function invalidSettings(agentId: string): AgentIntegrationError {
  return new AgentIntegrationError(
    'INVALID_SETTINGS',
    `Invalid settings for ${agentId}`,
    false,
  );
}
