import { describe, expect, it } from 'vitest';
import { buildPermissionOptions, buildThinkingOptions } from '$lib/chat/composer-controls';
import type { PermissionMode } from '$lib/types/chat';

const ALL_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
	'bypassPermissions',
	'plan',
];

describe('composer mode tones', () => {
	it('reserves the warning tone for the unsafe bypass-permissions state only', () => {
		const permissions = buildPermissionOptions(ALL_PERMISSION_MODES);
		const warningPermissions = permissions.filter((option) =>
			option.toneClass.includes('status-warning'),
		);

		expect(warningPermissions.map((option) => option.value)).toEqual(['bypassPermissions']);
	});

	it('keeps benign thinking effort tones free of warning and danger colors', () => {
		const thinking = buildThinkingOptions();

		for (const option of thinking) {
			expect(option.toneClass).not.toContain('status-warning');
			expect(option.toneClass).not.toContain('destructive');
		}
	});
});
