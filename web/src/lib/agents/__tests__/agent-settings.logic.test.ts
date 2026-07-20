import { describe, expect, it } from 'vitest';
import type { AgentSettingDescriptor } from '$shared/agent-integration';
import {
	createEmptyAgentSettings,
	normalizeAgentSettings,
	withAgentSetting,
} from '../agent-settings';

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
});
