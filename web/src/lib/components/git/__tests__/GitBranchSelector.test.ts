import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitBranchSelector from '../GitBranchSelector.svelte';

function renderSelector(overrides: Record<string, unknown> = {}) {
	return render(GitBranchSelector, {
		currentBranch: 'main',
		branches: ['main', 'feature/search'],
		isOpen: true,
		onToggle: vi.fn(),
		onClose: vi.fn(),
		onSwitchBranch: vi.fn(),
		...overrides,
	});
}

describe('GitBranchSelector switch-confirmation dialog', () => {
	afterEach(async () => {
		cleanup();
		// Allows bits-ui's delayed body-scroll cleanup to run before happy-dom teardown.
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('confirms a branch switch and reclaims focus when the dialog closes', async () => {
		const onSwitchBranch = vi.fn();
		const onSwitchDialogClose = vi.fn();
		renderSelector({ onSwitchBranch, onSwitchDialogClose });

		await fireEvent.click(screen.getByRole('option', { name: 'feature/search' }));
		expect(screen.getByRole('heading', { name: 'Switch to branch feature/search?' })).toBeTruthy();
		expect(onSwitchBranch).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));

		expect(onSwitchBranch).toHaveBeenCalledWith('feature/search');
		await waitFor(() => expect(onSwitchDialogClose).toHaveBeenCalled());
	});

	it('reclaims focus when the switch is cancelled', async () => {
		const onSwitchBranch = vi.fn();
		const onSwitchDialogClose = vi.fn();
		renderSelector({ onSwitchBranch, onSwitchDialogClose });

		await fireEvent.click(screen.getByRole('option', { name: 'feature/search' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onSwitchBranch).not.toHaveBeenCalled();
		await waitFor(() => expect(onSwitchDialogClose).toHaveBeenCalled());
	});
});
