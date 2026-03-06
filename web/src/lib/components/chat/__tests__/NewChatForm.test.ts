import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import NewChatFormTestHarness from './NewChatFormTestHarness.svelte';
import * as settingsApi from '$lib/api/settings';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn()
}));

vi.mock('$lib/api/settings', () => ({
	getSettings: vi.fn(),
	updateSettings: vi.fn()
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('NewChatForm', () => {
	it('shows a centered spinner and hides the composer until settings load', async () => {
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.getSettings>>>();
		vi.mocked(settingsApi.getSettings).mockReturnValueOnce(pending.promise);

		const { container } = render(NewChatFormTestHarness);
		const pathInput = screen.getByLabelText('Project Path') as HTMLInputElement;

		expect(screen.getByRole('status', { name: 'Loading chat defaults...' })).toBeTruthy();
		expect(pathInput.disabled).toBe(true);
		expect(container.querySelector('div.invisible textarea')).toBeTruthy();

		pending.resolve({
			ui: {},
			paths: {},
			pinnedChatIds: [],
			lastProvider: 'claude',
			lastProjectPath: '/workspace/project',
			lastModel: 'opus',
			lastPermissionMode: 'default',
			lastThinkingMode: 'none',
			projectBasePath: '/workspace'
		});

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		expect(pathInput.disabled).toBe(false);
		expect(container.querySelector('div.invisible textarea')).toBeNull();
	});
});
