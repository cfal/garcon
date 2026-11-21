import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewBranchModalTestHost from './NewBranchModalTestHost.svelte';
import { ApiError } from '$lib/api/client.js';
import { generateGitName } from '$lib/api/git-name.js';

vi.mock('$lib/api/git-name.js', () => ({ generateGitName: vi.fn() }));

function renderModal(overrides: Record<string, unknown> = {}) {
	return render(NewBranchModalTestHost, {
		currentBranch: 'main',
		newBranchName: 'feature/ref-base',
		refOptions: [
			{
				name: 'main',
				ref: 'refs/heads/main',
				kind: 'local-branch',
				updatedAt: null,
			},
			{
				name: 'origin/main',
				ref: 'refs/remotes/origin/main',
				kind: 'remote-branch',
				updatedAt: null,
			},
			{ name: 'v1.0.0', ref: 'refs/tags/v1.0.0', kind: 'tag', updatedAt: null },
		],
		selectedBaseRef: '',
		isLoadingRefs: false,
		isCreatingBranch: false,
		onNameChange: vi.fn(),
		onBaseRefChange: vi.fn(),
		onSearchRefs: vi.fn(),
		onCreateBranch: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	});
}

describe('NewBranchModal', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('can suggest a branch name without creating a branch', async () => {
		const onNameChange = vi.fn();
		const onCreateBranch = vi.fn();
		vi.mocked(generateGitName).mockResolvedValue({ name: 'release-tools' });
		renderModal({ newBranchName: '', onNameChange, onCreateBranch });
		expect(generateGitName).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Generate name' }));
		expect(onNameChange).toHaveBeenCalledWith('release-tools');
		expect(onCreateBranch).not.toHaveBeenCalled();
	});

	it('keeps keyboard focus and does not duplicate a pending name request', async () => {
		const reply = Promise.withResolvers<{ name: string }>();
		vi.mocked(generateGitName).mockReturnValueOnce(reply.promise);
		renderModal();
		const generate = screen.getByRole<HTMLButtonElement>('button', { name: 'Generate name' });
		generate.focus();
		await fireEvent.click(generate);
		expect(generate.disabled).toBe(false);
		expect(generate.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(generate);
		expect(generateGitName).toHaveBeenCalledTimes(1);
		reply.reject(new ApiError(422, 'Unsupported', 'UNSUPPORTED_AGENT'));
		expect((await screen.findByRole('alert')).textContent).toContain('Choose a different agent');
		expect(document.activeElement).toBe(generate);
		expect(generate.getAttribute('aria-disabled')).toBe('false');
	});

	it('searches refs for the branch base selector and selects the full ref', async () => {
		const onBaseRefChange = vi.fn();
		const onSearchRefs = vi.fn();
		renderModal({ onBaseRefChange, onSearchRefs });

		await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a ref' }), {
			target: { value: 'origin/main' },
		});
		await new Promise((resolve) => window.setTimeout(resolve, 180));

		expect(onSearchRefs).toHaveBeenCalledWith('origin/main');
		expect(screen.getByRole('option', { name: /origin\/main/ })).toBeTruthy();
		expect(screen.queryByRole('option', { name: /v1\.0\.0/ })).toBeNull();

		await fireEvent.change(screen.getByRole('combobox', { name: 'Base' }), {
			target: { value: 'refs/remotes/origin/main' },
		});

		expect(onBaseRefChange).toHaveBeenCalledWith('refs/remotes/origin/main');
	});

	it('keeps a selected base ref visible when the current search result page does not include it', () => {
		renderModal({
			refOptions: [{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch' }],
			selectedBaseRef: 'refs/remotes/origin/release',
		});

		expect(screen.getByRole('option', { name: 'refs/remotes/origin/release' })).toBeTruthy();
	});
});
