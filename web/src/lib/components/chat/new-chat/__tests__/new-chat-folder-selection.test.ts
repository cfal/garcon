import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NewChatFolderSelection } from '../new-chat-folder-selection.svelte';
import { selectDirectory } from '$lib/api/files';
import type { DirectorySelectionResult } from '$shared/file-contracts';

vi.mock('$lib/api/files', () => ({ selectDirectory: vi.fn() }));

function fixture() {
	const form = {
		executorId: 'local', worktreeContextKey: 'local-1', nonblankPath: '/workspace/current',
		browseStartPath: '/workspace', projectBasePath: '/workspace', filesAvailable: true,
		isUpdatingPinnedPath: false, showBrowser: false, selectProjectPath: vi.fn(),
	};
	return { form, selection: new NewChatFolderSelection(() => form), browser: vi.fn() };
}

function deferred() {
	let resolve!: (result: DirectorySelectionResult) => void;
	const promise = new Promise<DirectorySelectionResult>((accept) => { resolve = accept; });
	return { promise, resolve };
}

describe('New Chat system folder selection', () => {
	beforeEach(() => vi.mocked(selectDirectory).mockReset());
	it('selects the returned full path and keeps cancellation separate from fallback', async () => {
		const { form, selection, browser } = fixture();
		vi.mocked(selectDirectory).mockResolvedValueOnce({ status: 'selected', path: '/workspace/chosen' });
		await selection.choose(browser);
		expect(selectDirectory).toHaveBeenCalledWith('local', '/workspace/current', expect.any(AbortSignal));
		expect(form.selectProjectPath).toHaveBeenCalledExactlyOnceWith('/workspace/chosen');
		vi.mocked(selectDirectory).mockResolvedValueOnce({ status: 'cancelled' });
		await selection.choose(browser);
		expect(form.selectProjectPath).toHaveBeenCalledTimes(1);
		expect(browser).not.toHaveBeenCalled();
	});
	it('opens Garcon browsing only when the system picker is unsupported', async () => {
		const { form, selection, browser } = fixture();
		vi.mocked(selectDirectory).mockResolvedValueOnce({ status: 'unsupported' });
		await selection.choose(browser);
		expect(browser).toHaveBeenCalledOnce();
		expect(form.selectProjectPath).not.toHaveBeenCalled();
	});
	it.each(['executor', 'connection', 'path', 'close'] as const)('fences a late result after %s changes', async (change) => {
		const { form, selection, browser } = fixture();
		const pending = deferred();
		vi.mocked(selectDirectory).mockReturnValueOnce(pending.promise);
		const chosen = selection.choose(browser);
		if (change === 'executor') form.executorId = 'other';
		if (change === 'connection') form.worktreeContextKey = 'local-2';
		if (change === 'path') form.nonblankPath = '/workspace/other';
		if (change === 'close') selection.cancel();
		pending.resolve({ status: 'selected', path: '/workspace/stale' });
		await chosen;
		expect(form.selectProjectPath).not.toHaveBeenCalled();
		expect(browser).not.toHaveBeenCalled();
		expect(selection.pending).toBe(false);
	});
	it('blocks duplicate requests and exposes failures without losing selection', async () => {
		const { form, selection, browser } = fixture();
		vi.mocked(selectDirectory).mockRejectedValueOnce(new Error('Synthetic dialog failure'));
		const chosen = selection.choose(browser);
		await selection.choose(browser);
		await chosen;
		expect(selectDirectory).toHaveBeenCalledOnce();
		expect(selection.failed).toBe(true);
		expect(form.selectProjectPath).not.toHaveBeenCalled();
		expect(browser).not.toHaveBeenCalled();
	});
});
