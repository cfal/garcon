import { describe, expect, it } from 'vitest';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import { NewChatAgentSettingsState } from '../new-chat-agent-settings-state.svelte';

const descriptor: AgentSettingDescriptor = { key: 'mode', label: 'Mode', type: 'string' };
const defaults: AgentSettingsEnvelope = { ownerId: 'synthetic', schemaVersion: 3, values: { mode: 'current' } };
const catalog = {
	getDefaultAgentSettings: () => defaults,
	getAgentSettingsDescriptors: () => [descriptor],
};

describe('NewChatAgentSettingsState', () => {
	it('preserves incompatible saved settings without mixing in current values', () => {
		const settings = new NewChatAgentSettingsState();
		const saved = { ownerId: 'synthetic', schemaVersion: 1, values: {} };
		settings.restore({ synthetic: saved }, ['synthetic'], catalog);
		settings.reconcileCatalog(['synthetic'], catalog);
		settings.setSetting('synthetic', descriptor, 'edited', catalog);
		expect(settings.isCompatible('synthetic', catalog)).toBe(false);
		expect(settings.forAgent('synthetic', catalog)).toEqual(saved);
	});

	it('uses actual defaults for absence, distinct from a real empty schema-1 envelope', () => {
		const settings = new NewChatAgentSettingsState();
		settings.restore({}, ['synthetic'], catalog);
		expect(settings.forAgent('synthetic', catalog)).toEqual(defaults);
		expect(settings.isCompatible('synthetic', catalog)).toBe(true);
	});

	it('keeps unavailable defaults unavailable rather than inventing a schema', () => {
		const unavailable = { ...catalog, getDefaultAgentSettings: () => null };
		const settings = new NewChatAgentSettingsState();
		settings.ensure('synthetic', unavailable);
		settings.setSetting('synthetic', descriptor, 'edited', unavailable);
		expect(settings.forAgent('synthetic', unavailable)).toBeNull();
		expect(settings.isCompatible('synthetic', unavailable)).toBe(false);
		expect(settings.byId).toEqual({});
	});
});
