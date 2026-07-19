import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { JsonObject, JsonValue } from '$shared/json';

export function createEmptyAgentSettings(ownerId: string): AgentSettingsEnvelope {
	return { ownerId, schemaVersion: 1, values: {} };
}

export function normalizeAgentSettings(
	ownerId: string,
	value: AgentSettingsEnvelope | null | undefined,
	fallback: AgentSettingsEnvelope,
): AgentSettingsEnvelope {
	if (value?.ownerId !== ownerId) return cloneAgentSettings(fallback);
	return cloneAgentSettings(value);
}

export function cloneAgentSettings(value: AgentSettingsEnvelope): AgentSettingsEnvelope {
	return {
		ownerId: value.ownerId,
		schemaVersion: value.schemaVersion,
		values: cloneJsonObject(value.values),
	};
}

export function settingValue(
	envelope: AgentSettingsEnvelope,
	descriptor: AgentSettingDescriptor,
): JsonValue | undefined {
	return envelope.values[descriptor.key];
}

export function withAgentSetting(
	envelope: AgentSettingsEnvelope,
	descriptor: AgentSettingDescriptor,
	value: JsonValue,
): AgentSettingsEnvelope {
	if (!isDescriptorValue(descriptor, value)) return envelope;
	return {
		...envelope,
		values: {
			...envelope.values,
			[descriptor.key]: value,
		},
	};
}

function isDescriptorValue(descriptor: AgentSettingDescriptor, value: JsonValue): boolean {
	switch (descriptor.type) {
		case 'boolean':
			return typeof value === 'boolean';
		case 'enum':
			return (
				typeof value === 'string' && descriptor.options.some((option) => option.value === value)
			);
		case 'number':
			return (
				typeof value === 'number' &&
				Number.isFinite(value) &&
				value >= descriptor.min &&
				value <= descriptor.max
			);
		case 'string':
		case 'credential-ref':
			return typeof value === 'string';
	}
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
	);
}

function cloneJsonValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(cloneJsonValue);
	if (value && typeof value === 'object') return cloneJsonObject(value as JsonObject);
	return value;
}
