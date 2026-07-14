import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestSummary } from '$lib/api/pull-requests';
import { PullRequestsStore } from '$lib/stores/pull-requests.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import PullRequestsPanelTestHost from './PullRequestsPanelTestHost.svelte';

function summary(number: number): PullRequestSummary {
	return {
		number,
		title: `PR ${number}`,
		state: 'open',
		isDraft: false,
		author: 'octocat',
		headRefName: 'feat/container-layout',
		baseRefName: 'main',
		additions: 1,
		deletions: 0,
		changedFiles: 1,
		updatedAt: '2026-07-13T00:00:00Z',
		url: `https://example.test/pull/${number}`,
		reviewDecision: null,
		checksState: 'none',
	};
}

function makeController(): PullRequestsStore {
	const controller = new PullRequestsStore();
	controller.setCapability(true, true);
	controller.setProject('/project', 'project-key');
	controller.pulls = [summary(1), summary(2)];
	controller.hasLoaded = true;
	return controller;
}

describe('PullRequestsPanel container presentation', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		restoreResizeObserver();
	});

	it('uses host width for wide, compact, and list-to-detail layouts', async () => {
		const controller = makeController();
		const { container } = render(PullRequestsPanelTestHost, {
			props: {
				props: {
					controller,
					isMobile: false,
					onSendToChat: vi.fn().mockResolvedValue(true),
					onNavigateToChat: vi.fn(),
					onRetryCapability: vi.fn(),
				},
			},
		});
		const panel = container.querySelector('[data-pr-panel]');
		const list = container.querySelector('[data-pr-list]');
		const detail = container.querySelector('[data-pr-detail]');
		expect(panel).toBeTruthy();
		expect(list).toBeTruthy();
		expect(detail).toBeTruthy();
		if (!panel || !list || !detail) return;

		ResizeObserverHarness.emit(panel, 1_100);
		await waitFor(() => expect(panel.getAttribute('data-pr-layout')).toBe('wide'));
		expect(list.classList.contains('w-80')).toBe(true);

		ResizeObserverHarness.emit(panel, 800);
		await waitFor(() => expect(panel.getAttribute('data-pr-layout')).toBe('compact'));
		expect(list.classList.contains('w-60')).toBe(true);
		expect(list.classList.contains('hidden')).toBe(false);
		expect(detail.classList.contains('hidden')).toBe(false);

		ResizeObserverHarness.emit(panel, 480);
		await waitFor(() => expect(panel.getAttribute('data-pr-layout')).toBe('narrow'));
		expect(detail.classList.contains('hidden')).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: /#1 PR 1/ }));
		await waitFor(() => expect(list.classList.contains('hidden')).toBe(true));
		expect(detail.classList.contains('hidden')).toBe(false);
		expect(screen.getByRole('button', { name: 'All pull requests' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'All pull requests' }));
		await waitFor(() => expect(list.classList.contains('hidden')).toBe(false));
		expect(detail.classList.contains('hidden')).toBe(true);
	});
});
