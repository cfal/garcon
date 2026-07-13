import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewBranchModalTestHost from './NewBranchModalTestHost.svelte';

function renderModal(overrides: Record<string, unknown> = {}) {
	return render(NewBranchModalTestHost, {
		currentBranch: 'main',
		newBranchName: 'feature/ref-base',
		refOptions: [
			{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch' },
			{ name: 'origin/main', ref: 'refs/remotes/origin/main', kind: 'remote-branch' },
			{ name: 'v1.0.0', ref: 'refs/tags/v1.0.0', kind: 'tag' },
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
	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => window.setTimeout(resolve, 30));
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
