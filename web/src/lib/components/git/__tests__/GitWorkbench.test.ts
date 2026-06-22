import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitWorkbenchStore, GitWorkbenchTarget } from '$lib/stores/git-workbench.svelte';
import GitWorkbench from '../GitWorkbench.svelte';

function makeTarget(): GitWorkbenchTarget {
	return {
		projectPath: '/project',
		repoRoot: '/project',
		worktreePath: '/project',
		label: 'project',
		source: 'chat-project',
	};
}

function makeWorkbenchStub(): GitWorkbenchStore {
	return {
		target: null,
		lastError: null,
		repositoryError: null,
		isInitialLoadPending: false,
		reviewModalOpen: false,
		reviewComments: [],
		reviewSummary: '',
		commentsByFile: {},
		commentComposer: {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		pendingDiscardFile: null,
		setTarget: vi.fn().mockResolvedValue(undefined),
		dismissError: vi.fn(),
	} as unknown as GitWorkbenchStore;
}

describe('GitWorkbench', () => {
	it('shows an initial loading state before the store adopts the rendered target', () => {
		render(GitWorkbench, {
			props: {
				target: makeTarget(),
				isMobile: false,
				wb: makeWorkbenchStub(),
				diffFontSize: 12,
			},
		});

		expect(screen.getByText('Loading Git changes...')).toBeTruthy();
		expect(screen.queryByText('No changed files')).toBeNull();
	});
});
