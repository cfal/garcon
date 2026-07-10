import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';

vi.mock('../ScheduledTasksSection.svelte', async () =>
	import('./ScheduledTasksSectionTestStub.svelte'),
);

const ScheduledTasksDialogTestHost = (
	await import('./ScheduledTasksDialogTestHost.svelte')
).default;

describe('ScheduledTasksDialog', () => {
	afterEach(async () => {
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('uses a maximized mobile frame and closes through app shell state', async () => {
		const appShell = createAppShellStore();
		appShell.openScheduledTasks();
		render(ScheduledTasksDialogTestHost, { appShell });

		const dialog = screen.getByRole('dialog');
		expect(screen.getByRole('heading', { name: 'Scheduled Tasks' })).toBeTruthy();
		expect(screen.getByText('Scheduled tasks content')).toBeTruthy();
		expect(dialog.className).toContain('h-dvh');
		expect(dialog.className).toContain('w-screen');
		expect(dialog.className).toContain('rounded-none');
		expect(dialog.className).toContain('sm:h-[80dvh]');

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(appShell.showScheduledTasks).toBe(false);
	});
});
