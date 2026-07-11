import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';

vi.mock(
	'../ScheduledPromptsSection.svelte',
	async () => import('./ScheduledPromptsSectionTestStub.svelte'),
);

const ScheduledPromptsDialogTestHost = (await import('./ScheduledPromptsDialogTestHost.svelte'))
	.default;

describe('ScheduledPromptsDialog', () => {
	afterEach(async () => {
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('uses a maximized mobile frame and closes through app shell state', async () => {
		const appShell = createAppShellStore();
		appShell.openScheduledPrompts();
		render(ScheduledPromptsDialogTestHost, { appShell });

		const dialog = screen.getByRole('dialog');
		expect(screen.getByRole('heading', { name: 'Scheduled Prompts' })).toBeTruthy();
		expect(screen.getByText('Scheduled prompts content')).toBeTruthy();
		expect(dialog.className).toContain('h-dvh');
		expect(dialog.className).toContain('w-screen');
		expect(dialog.className).toContain('rounded-none');
		expect(dialog.className).toContain('sm:h-[80dvh]');

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(appShell.showScheduledPrompts).toBe(false);
	});
});
