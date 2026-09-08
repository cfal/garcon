import { describe, expect, it } from 'bun:test';
import type { AgentSettingDescriptor } from '../../agent-integration.js';
import {
	cloneAgentSettings,
	createEmptyAgentSettings,
	normalizeAgentSettings,
	withAgentSetting,
} from '../agent-settings.ts';

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

	it('deeply clones JSON settings values', () => {
		const original = {
			ownerId: 'sample',
			schemaVersion: 1,
			values: { nested: { choices: ['one', 'two'] } },
		};
		const cloned = cloneAgentSettings(original);

		expect(cloned).toEqual(original);
		expect(cloned).not.toBe(original);
		expect(cloned.values.nested).not.toBe(original.values.nested);
	});
});
