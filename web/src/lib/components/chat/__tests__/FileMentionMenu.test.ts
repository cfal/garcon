import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileMentionMenuTestHost from './FileMentionMenuTestHost.svelte';
import { getFileList } from '$lib/api/files.js';

vi.mock('$lib/api/files.js', () => ({
	getFileList: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('FileMentionMenu', () => {
	beforeEach(() => {
		vi.mocked(getFileList).mockReset();
	});

	it('shows project-relative files and excludes directory entries', async () => {
		vi.mocked(getFileList).mockResolvedValue([
			{ name: 'src', path: '/repo/src', type: 'directory' },
			{ name: 'main.ts', path: '/repo/src/main.ts', relativePath: 'src/main.ts', type: 'file' },
		]);
		const onSelect = vi.fn();

		render(FileMentionMenuTestHost, {
			projectPath: '/repo',
			isVisible: true,
			query: 'main',
			onSelect,
			onClose: vi.fn(),
		});

		const item = await screen.findByRole('button', { name: /src\/main\.ts/ });
		expect(screen.queryByText('/repo/src')).toBeNull();

		await fireEvent.click(item);

		expect(onSelect).toHaveBeenCalledWith('src/main.ts');
	});

	it('supports keyboard selection through its public handler', async () => {
		vi.mocked(getFileList).mockResolvedValue([
			{ name: 'a.ts', path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
			{ name: 'b.ts', path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' },
		]);
		const onSelect = vi.fn();
		const { component } = render(FileMentionMenuTestHost, {
			projectPath: '/repo',
			isVisible: true,
			query: '',
			onSelect,
			onClose: vi.fn(),
		});

		await waitFor(() => {
			expect(screen.getByText('a.ts')).toBeTruthy();
			expect(screen.getByText('b.ts')).toBeTruthy();
		});

		component.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		component.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

		expect(onSelect).toHaveBeenCalledWith('b.ts');
	});

	it('restarts a file request aborted by a pending project transition', async () => {
		const first = deferred<Awaited<ReturnType<typeof getFileList>>>();
		vi.mocked(getFileList)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce([
				{ name: 'recovered.ts', path: '/repo/recovered.ts', relativePath: 'recovered.ts' },
			]);
		const view = render(FileMentionMenuTestHost, {
			projectPath: '/repo',
			isVisible: true,
			query: '',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});
		await waitFor(() => expect(getFileList).toHaveBeenCalledOnce());
		const firstSignal = vi.mocked(getFileList).mock.calls[0]?.[1]?.signal;

		await view.rerender({ projectPath: '', projectPending: true });
		expect(firstSignal?.aborted).toBe(true);
		await view.rerender({ projectPath: '/repo', projectPending: false });

		await waitFor(() => expect(getFileList).toHaveBeenCalledTimes(2));
		expect(await screen.findByText('recovered.ts')).toBeTruthy();
		first.resolve([]);
		await tick();
		expect(screen.getByText('recovered.ts')).toBeTruthy();
	});

	it('blocks cached file selection while the project is unavailable', async () => {
		vi.mocked(getFileList).mockResolvedValue([
			{ name: 'cached.ts', path: '/repo/cached.ts', relativePath: 'cached.ts' },
		]);
		const onSelect = vi.fn();
		const view = render(FileMentionMenuTestHost, {
			projectPath: '/repo',
			isVisible: true,
			query: '',
			onSelect,
			onClose: vi.fn(),
		});
		await screen.findByText('cached.ts');

		await view.rerender({ projectUnavailable: true });
		view.component.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

		expect(screen.queryByText('cached.ts')).toBeNull();
		expect(onSelect).not.toHaveBeenCalled();
	});
});
