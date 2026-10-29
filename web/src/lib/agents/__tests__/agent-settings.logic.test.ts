import { describe, expect, it } from 'vitest';
import type { AgentSettingDescriptor } from '$shared/agent-integration';
import {
	createEmptyAgentSettings,
	normalizeAgentSettings,
	withAgentSetting,
	areAgentSettingsCompatible,
} from '$shared/agent-settings';

const effort = {
	key: 'effort',
	type: 'enum',
	label: 'Effort',
	options: [
		{ value: 'low', label: 'Low' },
		{ value: 'high', label: 'High' },
	],
} satisfies AgentSettingDescriptor;

describe('agent settings', () => {
	it('checks the owner, exact schema and every saved value without rewriting settings', () => {
		const defaults = { ownerId: 'sample', schemaVersion: 2, values: { effort: 'low' } };
		expect(areAgentSettingsCompatible(defaults, defaults, [effort])).toBe(true);
		expect(areAgentSettingsCompatible({ ...defaults, values: {} }, defaults, [effort])).toBe(true);
		for (const envelope of [
			{ ...defaults, ownerId: 'another' }, { ...defaults, schemaVersion: 1 }, { ...defaults, schemaVersion: 3 },
			{ ...defaults, values: { effort: 'retired' } }, { ...defaults, values: { removed: true } },
		]) expect(areAgentSettingsCompatible(envelope, defaults, [effort])).toBe(false);
		expect(defaults.values).toEqual({ effort: 'low' });
	});
	it('updates declared values without changing the envelope identity fields', () => {
		const initial = { ownerId: 'sample', schemaVersion: 2, values: { effort: 'low' } } as const;
		expect(withAgentSetting(initial, effort, 'high')).toEqual({
			ownerId: 'sample',
			schemaVersion: 2,
			values: { effort: 'high' },
		});
	});

	it('rejects invalid descriptor values', () => {
		const initial = { ownerId: 'sample', schemaVersion: 1, values: { effort: 'low' } } as const;
		expect(withAgentSetting(initial, effort, 'maximum')).toBe(initial);
	});

	it('falls back instead of accepting settings owned by another integration', () => {
		const fallback = { ownerId: 'sample', schemaVersion: 1, values: { effort: 'low' } } as const;
		const mismatched = { ownerId: 'other', schemaVersion: 1, values: {} } as const;
		expect(normalizeAgentSettings('sample', mismatched, fallback)).toEqual(fallback);
		expect(createEmptyAgentSettings('sample')).toEqual({
			ownerId: 'sample',
			schemaVersion: 1,
			values: {},
		});
	});
});
