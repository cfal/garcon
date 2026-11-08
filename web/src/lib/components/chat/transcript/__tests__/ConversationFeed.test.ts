import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisplayWindowController } from '$lib/chat/transcript/display-window-controller.js';
import { ConversationFeedProjectionState } from '../ConversationFeedProjectionState.svelte.js';
import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import type { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { BashToolUseMessage } from '$shared/chat-types';
import { ApiError } from '$lib/api/client.js';

async function ready() {
	await waitFor(() => expect(screen.getByTestId('feed-fixture-ready').getAttribute('data-ready')).toBe('true'));
}

import ConversationFeedTestHost from './ConversationFeedTestHost.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';

async function showFeedScrollbar(container: HTMLElement): Promise<{
	scrollbar: HTMLElement;
	thumb: HTMLElement;
	viewport: HTMLElement;
}> {
	await ready();
	const root = container.querySelector<HTMLElement>('[data-scroll-area-root]');
	const viewport = container.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
	const content = container.querySelector<HTMLElement>('[data-scroll-area-content]');
	if (!root || !viewport || !content) throw new Error('Expected the feed scroll-area elements');
	Object.defineProperties(viewport, {
		offsetHeight: { configurable: true, value: 720 },
		offsetWidth: { configurable: true, value: 900 },
		scrollHeight: { configurable: true, value: 4_000 },
		scrollWidth: { configurable: true, value: 900 },
	});
	await waitFor(() => {
		expect(
			ResizeObserverHarness.instances.some((observer) => observer.observed.has(viewport)),
		).toBe(true);
		expect(ResizeObserverHarness.instances.some((observer) => observer.observed.has(content))).toBe(
			true,
		);
	});
	for (const observer of ResizeObserverHarness.instances) {
		if (observer.observed.has(viewport)) {
			ResizeObserverHarness.emitFrom(observer, viewport, 900, 720);
		}
		if (observer.observed.has(content)) {
			ResizeObserverHarness.emitFrom(observer, content, 900, 4_000);
		}
	}
	await fireEvent.pointerEnter(root);
	await waitFor(() => {
		expect(container.querySelector('[data-chat-feed-scrollbar]')).not.toBeNull();
		expect(container.querySelector('[data-slot="scroll-area-thumb"]')).not.toBeNull();
	});
	const scrollbar = container.querySelector<HTMLElement>('[data-chat-feed-scrollbar]');
	const thumb = container.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]');
	if (!scrollbar || !thumb) throw new Error('Expected the feed scrollbar and thumb');
	await tick();
	return { scrollbar, thumb, viewport };
}

describe('ConversationFeed', () => {
	const originalOffsetHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		'offsetHeight',
	);
	const originalClientHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		'clientHeight',
	);

	let restoreResizeObserver: () => void;
	beforeAll(() => {
		// Bits UI retains one shared observer for the lifetime of its module.
		restoreResizeObserver = installResizeObserverHarness();
	});
	afterAll(() => restoreResizeObserver());

	beforeEach(() => {
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement,
		) {
			const itemIndex = Number(this.dataset.index ?? 0);
			const itemHeights = [48, 96, 180, 240];
			const height = this.hasAttribute('data-scroll-area-viewport')
				? 720
				: this.hasAttribute('data-chat-virtual-item')
					? itemHeights[itemIndex % itemHeights.length]
					: 100;
			return {
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: 900,
				bottom: height,
				width: 900,
				height,
				toJSON: () => ({}),
			} as DOMRect;
		});
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
			configurable: true,
			get() {
				if (!this.hasAttribute('data-chat-virtual-item')) return 0;
				const itemHeights = [48, 96, 180, 240];
				return itemHeights[Number(this.dataset.index ?? 0) % itemHeights.length];
			},
		});
		Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
			configurable: true,
			get() {
				if (this.hasAttribute('data-chat-scroll-viewport')) return 720;
				return originalClientHeight?.get?.call(this) ?? 0;
			},
		});
	});

	it('does not recenter the sidebar when the message feed receives focus', async () => {
		const { container } = render(ConversationFeedTestHost);
		const viewport = container.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
		if (!viewport) throw new Error('Expected the chat feed viewport');

		await fireEvent.focusIn(viewport);

		expect(screen.getByTestId('sidebar-recenter-request-count').textContent).toBe('0');
	});

	it('never presents uncertified or cancelled history as empty', async () => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		render(ConversationFeedTestHost, { transcriptScenario: 'tool-run', onReady: mounted.resolve });
		const transcript = await mounted.promise;
		transcript.clearMessages();
		transcript.beginOpen();
		transcript.cancelOpen();
		await tick();
		expect(screen.queryByText('No messages')).toBeNull();
		expect(screen.queryByText(/Send.*first message/)).toBeNull();
		expect(screen.getByText('Loading messages...')).toBeTruthy();
	});

	it.each([false, true])('preserves nonretryable archived history presentation, permission=%s', async permission => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		render(ConversationFeedTestHost, { transcriptScenario: 'tool-run', onReady: mounted.resolve, onRetry: vi.fn(),
			pendingPermissionRequests: permission ? [{ chatId: 'chat-1', permissionOccurrenceId: 'pending-permission',
				requestedTool: new BashToolUseMessage('', 'tool-1', 'true'),
				control: { serverInstanceId: 'instance-1', chatId: 'chat-1', runId: 'run-1', permissionOccurrenceId: 'pending-permission' } }] : [],
		});
		const transcript = await mounted.promise;
		transcript.clearMessages();
		transcript.failOpen(new ApiError(410, 'Synthetic archived source', 'TRANSCRIPT_UNAVAILABLE', undefined, false));
		await screen.findByText('Archived history for this chat is unavailable.');
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
		if (permission) expect(screen.getByText('Permission required')).toBeTruthy();
	});

	it('offers Retry for an unstructured intermediary failure', async () => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		const retry = vi.fn();
		render(ConversationFeedTestHost, { transcriptScenario: 'tool-run', onReady: mounted.resolve, onRetry: retry });
		const transcript = await mounted.promise;
		transcript.clearMessages();
		transcript.failOpen(new ApiError(502, 'Bad Gateway'));
		await screen.findByText('Bad Gateway');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(retry).toHaveBeenCalledOnce();
	});

	it('shows initial failure and retry alongside an actionable permission', async () => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		const retry = vi.fn();
		render(ConversationFeedTestHost, { transcriptScenario: 'tool-run', onReady: mounted.resolve, onRetry: retry,
			pendingPermissionRequests: [{ chatId: 'chat-1', permissionOccurrenceId: 'pending-permission',
				requestedTool: new BashToolUseMessage('', 'tool-1', 'true'),
				control: { serverInstanceId: 'instance-1', chatId: 'chat-1', runId: 'run-1', permissionOccurrenceId: 'pending-permission' } }],
		});
		const transcript = await mounted.promise;
		transcript.clearMessages();
		transcript.failOpen(new Error('Synthetic display failure'));
		await screen.findByText('Permission required');
		await screen.findByText('Synthetic display failure');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(retry).toHaveBeenCalledOnce();
	});

	it('keeps a focused protected row mounted when filtering empties the certified window', async () => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		const remoteSettingsStore = new RemoteSettingsStore();
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'bash-filter', remoteSettingsStore, onReady: mounted.resolve });
		const transcript = await mounted.promise;
		const protect = vi.spyOn(transcript.controller, 'protect');
		const row = await waitFor(() => {
			const element = container.querySelector<HTMLElement>('[data-chat-row-id="generation-1:1"]');
			expect(element).not.toBeNull();
			return element!;
		});
		row.focus();
		await fireEvent.focusIn(row);
		await tick();
		expect(protect).toHaveBeenCalledWith([1]);
		remoteSettingsStore.applySnapshot(makeRemoteSettingsSnapshot({ version: 1, ui: { hiddenBashCommandPatterns: [{ pattern: 'git *', mode: 'glob' }] } }));
		await waitFor(() => expect(transcript.display.window?.items).toHaveLength(0));
		expect(transcript.display.protectedRows).toHaveLength(1);
		expect(container.querySelector('[data-chat-virtual-sizer]')).not.toBeNull();
		expect(container.querySelector('[data-chat-row-id="generation-1:1"]')).toBe(row);
	});

	it('admits explicit initial navigation while the mounted feed is still pinned', async () => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		render(ConversationFeedTestHost, { transcriptScenario: 'local-truncation', onReady: mounted.resolve });
		const transcript = await mounted.promise;
		expect(transcript.entries[0].ordinal).toBeGreaterThan(1);
		expect(await transcript.navigateToWindow('chat-1', 'initial')).toBe('loaded');
		expect(transcript.entries[0].ordinal).toBe(1);
		expect(transcript.hasLaterMessages).toBe(true);
	});

	it('keeps a focused summary mounted when filtering empties the certified window', async () => {
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		const remoteSettingsStore = new RemoteSettingsStore();
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'bash-filter', remoteSettingsStore, onReady: mounted.resolve });
		const transcript = await mounted.promise;
		const snapshot = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}');
		const newValue = JSON.stringify({ ...snapshot, combineToolUseMessages: true });
		localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, newValue);
		window.dispatchEvent(new StorageEvent('storage', { key: LOCAL_STORAGE_KEYS.localSettings, newValue, storageArea: localStorage }));
		const group = await screen.findByRole('button', { name: 'Execute a command' });
		group.focus();
		await fireEvent.focusIn(group);
		await tick();
		remoteSettingsStore.applySnapshot(makeRemoteSettingsSnapshot({ version: 1, ui: { hiddenBashCommandPatterns: [{ pattern: 'git *', mode: 'glob' }] } }));
		await waitFor(() => expect(transcript.display.window?.items).toHaveLength(0));
		expect(transcript.display.protectedGroups).toHaveLength(1);
		expect(transcript.display.protectedRows).toHaveLength(0);
		expect(container.querySelector('[data-chat-virtual-sizer]')).not.toBeNull();
		expect(container.querySelector('[data-chat-tool-group]')).toBe(group);
	});

	it('classifies a profile replacement caused by boundary demand in its first projection', async () => {
		const projected = vi.spyOn(ConversationFeedProjectionState.prototype, 'reconcile');
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		render(ConversationFeedTestHost, { transcriptScenario: 'local-truncation', onReady: mounted.resolve });
		const transcript = await mounted.promise;
		const profile = transcript.display.window!.certificate.profileKey;
		transcript.configureDisplay({ combine: false, showThinking: false, hiddenToolGroups: [] });
		const revision = transcript.feedMutationClock.dataRevision;
		projected.mockClear();
		await transcript.loadEarlierPage('chat-1');
		await tick();
		const changed = projected.mock.calls.find(([input]) => input.display.window && input.display.window.certificate.profileKey !== profile)?.[0];
		expect(changed).toBeDefined();
		expect(changed!.mutationClock.lastRevisionByKind['history-earlier']).toBeGreaterThan(revision);
	});

	it.each(['explicit', 'coverage'])('classifies earlier history in the same projection as its %s prepend', async entry => {
		const projected = vi.spyOn(ConversationFeedProjectionState.prototype, 'reconcile');
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		render(ConversationFeedTestHost, { transcriptScenario: 'local-truncation', onReady: mounted.resolve });
		const transcript = await mounted.promise;
		const after = transcript.display.window!.interval.after;
		const revision = transcript.feedMutationClock.dataRevision;
		projected.mockClear();
		await (entry === 'explicit' ? transcript.loadEarlierPage('chat-1') : transcript.controller.load('earlier'));
		await tick();
		const changed = projected.mock.calls.find(([input]) => input.display.window && input.display.window.interval.after < after)?.[0];
		expect(changed).toBeDefined();
		expect(changed!.mutationClock.lastRevisionByKind['history-earlier']).toBeGreaterThan(revision);
	});

	it('combines ordinary tool rows behind an accessible disclosure without changing the off path', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'tool-run' });
		await waitFor(() => expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(3));
		expect(container.querySelector('[data-chat-tool-group]')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle combination' }));
		const group = await screen.findByRole('button', { name: 'Execute 3 commands' });
		expect(group.classList.contains('typography-chat-prose')).toBe(true);
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(group.hasAttribute('aria-controls')).toBe(false);
		expect(group.firstElementChild?.querySelector('svg')).not.toBeNull();
		expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(0);
		group.focus();
		await fireEvent.focusIn(group);
		await tick();
		await fireEvent.click(group);
		await waitFor(() => expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(3));
		expect(group.getAttribute('aria-expanded')).toBe('true');
		expect(group.nextElementSibling?.classList.contains('h-2')).toBe(true);
		await fireEvent.click(group);
		await waitFor(() => expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(0));
		expect(group.getAttribute('aria-expanded')).toBe('false');
	});

	it('moves focus to a surviving member when combination is disabled in another tab', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'tool-run' });
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle combination' }));
		const group = await screen.findByRole('button', { name: 'Execute 3 commands' });
		group.focus();

		const snapshot = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}');
		const newValue = JSON.stringify({ ...snapshot, combineToolUseMessages: false });
		localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, newValue);
		window.dispatchEvent(new StorageEvent('storage', {
			key: LOCAL_STORAGE_KEYS.localSettings,
			newValue,
			storageArea: localStorage,
		}));

		await waitFor(() => expect(container.querySelector('[data-chat-tool-group]')).toBeNull());
		await waitFor(() => {
			expect(document.activeElement).not.toBe(document.body);
			expect((document.activeElement as HTMLElement).dataset.chatRowId).toBe('generation-1:1');
		});
	});

	it('moves focus from a member to the summary before explicitly collapsing', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'tool-run' });
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle combination' }));
		const group = await screen.findByRole('button', { name: 'Execute 3 commands' });
		await fireEvent.click(group);
		await waitFor(() => expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(3));
		const member = container.querySelector<HTMLElement>('[data-chat-row-id]');
		expect(member).not.toBeNull();
		member!.tabIndex = -1;
		member?.focus();

		group.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		await waitFor(() => expect(group.getAttribute('aria-expanded')).toBe('false'));
		expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(0);
		expect(document.activeElement).toBe(group);
	});

	it('keeps a large expanded tool run individually virtualized', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'large-tool-run' });
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle combination' }));
		const group = await screen.findByRole('button', { name: 'Execute 2000 commands' });
		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
		expect(Number(container.querySelector('[data-chat-virtual-sizer]')?.getAttribute('data-chat-virtual-model-count'))).toBe(3);
		await fireEvent.click(group);
		await waitFor(() => {
			const sizer = container.querySelector('[data-chat-virtual-sizer]');
			expect(Number(sizer?.getAttribute('data-chat-virtual-model-count'))).toBe(54);
			expect(Number(sizer?.getAttribute('data-chat-virtual-count'))).toBeLessThan(100);
		});
		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
	});

	it('continues exposed members despite viewport overflow without hydrating the entire run', async () => {
		vi.spyOn(ConversationFeedVirtualController.prototype, 'measureViewportFill').mockResolvedValue('overflow');
		const rectangle = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
			const rect = rectangle.call(this);
			const item = this.closest<HTMLElement>('[data-chat-virtual-item]');
			if (!item && !this.hasAttribute('data-chat-virtual-sizer')) return rect;
			const scroller = this.closest<HTMLElement>('[data-chat-scroll-viewport]');
			const top = (item ? Number(item.style.transform.match(/translateY\(([^p]+)px\)/)?.[1] ?? 0) : 0) - (scroller?.scrollTop ?? 0);
			return { ...rect, top, bottom: top + rect.height, y: top };
		});
		const mounted = Promise.withResolvers<ActiveTranscriptState>();
		let viewport: ConversationViewportPort | null = null;
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'large-tool-run', pinnedToBottom: false,
			onReady: mounted.resolve, onViewport: port => { viewport = port; } });
		const transcript = await mounted.promise;
		const parentLoad = vi.spyOn(transcript.controller, 'load');
		const scroller = container.querySelector<HTMLElement>('[data-chat-scroll-viewport]')!;
		Object.defineProperty(scroller, 'scrollHeight', { configurable: true,
			get: () => Number.parseFloat(container.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.style.height ?? '0') });
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle combination' }));
		const group = await screen.findByRole('button', { name: 'Execute 2000 commands' });
		const protect = vi.spyOn(transcript.controller, 'protectGroups');
		group.focus();
		await fireEvent.focusIn(group);
		await waitFor(() => expect(protect).toHaveBeenCalledWith([1]));
		await fireEvent.click(group);
		await waitFor(() => expect(transcript.display.expansions[0]?.page.ordinals).toHaveLength(50));
		await viewport!.waitForLayout();
		const extend = vi.spyOn(transcript.controller, 'extendMembers');
		viewport!.cancelForUserIntent('later');
		scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
		await fireEvent.scroll(scroller);
		await viewport!.waitForLayout();
		expect(viewport!.ownsScrollPosition()).toBe(false);
		viewport!.requestCoverage();
		await waitFor(() => expect(extend).toHaveBeenCalledWith(expect.objectContaining({ firstMember: 1 }), { kind: 'after', ordinal: 50 }));
		await waitFor(() => expect(transcript.display.expansions[0].page.ordinals).toContain(51));
		expect(parentLoad).not.toHaveBeenCalled();
		expect(transcript.display.expansions[0].page.ordinals.length).toBeLessThanOrEqual(100);
		expect(container.querySelectorAll('[data-chat-row-id]').length).toBeLessThan(100);
	});

	it('restores a collapsed summary but reveals exact durable members for row navigation', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'tool-run' });
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle combination' }));
		const group = await screen.findByRole('button', { name: 'Execute 3 commands' });
		await fireEvent.click(screen.getByRole('button', { name: 'Restore group summary' }));
		await waitFor(() => expect(screen.getByTestId('tool-navigation-result').textContent).toBe('completed'));
		expect(group.getAttribute('aria-expanded')).toBe('false');
		for (const [name, ordinal] of [
			['Navigate first tool', 1],
			['Navigate middle tool', 2],
			['Navigate last tool', 3],
		] as const) {
			await fireEvent.click(screen.getByRole('button', { name }));
			await waitFor(() => {
				expect(screen.getByTestId('tool-navigation-result').textContent).toBe('completed');
				expect(container.querySelector(`[data-chat-row-id="generation-1:${ordinal}"]`)).toBeTruthy();
			});
		}
		expect(group.getAttribute('aria-expanded')).toBe('true');
	});

	it('keeps simultaneous message and permission file links bound to their panel executor', async () => {
		const sessionsStore = createChatSessionsStore();
		const contexts = [
			{ chatId: 'chat-local', executorId: 'local', projectPath: '/workspace/local' },
			{ chatId: 'chat-remote', executorId: '22222222-2222-4222-8222-222222222222', projectPath: '/workspace/remote' },
		];
		for (const context of contexts) sessionsStore.createDraft({
			id: context.chatId, projectPath: context.projectPath,
			startup: { executorId: context.executorId, agentId: 'codex', model: 'synthetic', permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} }, firstMessage: 'Synthetic chat' },
		});
		const open = vi.spyOn(FileSessionRegistry.prototype, 'open').mockResolvedValue(null);
		const feeds = contexts.map((chatContext) => render(ConversationFeedTestHost, {
			chatContext, sessionsStore, transcriptScenario: 'file-links',
		}));
		for (const selected of contexts) {
			sessionsStore.setSelectedChatId(selected.chatId);
			await tick();
			for (const [index, context] of contexts.entries()) {
				const links = await waitFor(() => {
					const elements = feeds[index].container.querySelectorAll<HTMLAnchorElement>('a[href$=".txt"]');
					expect(elements).toHaveLength(2);
					return elements;
				});
				open.mockClear();
				for (const link of links) await fireEvent.click(link);
				if (context.executorId === 'local') {
					expect(open.mock.calls.map(([request]) => request.relativePath)).toEqual(['local/message.txt', 'local/plan.txt']);
				} else {
					expect(open).not.toHaveBeenCalled();
				}
			}
		}
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.localSettings);
		if (originalOffsetHeight) {
			Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
		}
		if (originalClientHeight) {
			Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
		}
	});

	it('represents viewport insets as measured virtual items', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });
		const viewport = screen.getByRole('region', { name: 'Chat messages' });

		await waitFor(() =>
			expect(container.querySelector('[data-chat-feed-viewport-start-spacer]')).toBeTruthy(),
		);
		expect(container.querySelector('[data-chat-feed-viewport-end-spacer]')).toBeTruthy();
		expect(viewport.classList.contains('pt-3')).toBe(false);
		expect(viewport.classList.contains('pb-3')).toBe(false);
	});

	it('bottom-aligns non-empty feeds without changing empty-state alignment', async () => {
		const populated = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });
		await waitFor(() =>
			expect(populated.container.querySelector('[data-chat-virtual-sizer]')).toBeTruthy(),
		);
		await ready();
		const populatedContent = populated.container.querySelector('[data-chat-feed-content]');
		expect(populatedContent?.classList.contains('min-h-full')).toBe(true);
		expect(populatedContent?.classList.contains('justify-end')).toBe(true);
		populated.unmount();

		const empty = render(ConversationFeedTestHost, { transcriptScenario: 'empty' });
		const emptyContent = empty.container.querySelector('[data-chat-feed-content]');
		expect(emptyContent?.classList.contains('min-h-full')).toBe(false);
		expect(emptyContent?.classList.contains('justify-end')).toBe(false);
	});

	it('uses fixed transcript typography without CSS zoom', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });

		await waitFor(() => expect(container.querySelector('[data-chat-virtual-sizer]')).toBeTruthy());
		expect(container.querySelector('[data-chat-transcript-scale]')).toBeNull();
		expect(container.querySelector('[style*="zoom"]')).toBeNull();
	});

	it('keeps feed content and scrollbar invisible while preparing the initial position', async () => {
		const { container, rerender } = render(ConversationFeedTestHost, {
			transcriptScenario: 'row-ids',
			isPreparingInitialScroll: true,
		});
		const viewport = container.querySelector('[data-chat-scroll-viewport]') as HTMLElement;
		expect(viewport.getAttribute('aria-busy')).toBe('true');
		const content = container.querySelector('[data-chat-feed-content]') as HTMLElement;
		expect(content.className).toContain('invisible');
		for (const scrollbar of container.querySelectorAll('[data-chat-feed-scrollbar]')) {
			expect(scrollbar.className).toContain('invisible');
		}

		await ready();
		await rerender({ isPreparingInitialScroll: false });
		expect(viewport.getAttribute('aria-busy')).toBe('false');
		expect(content.className).not.toContain('invisible');
		for (const scrollbar of container.querySelectorAll('[data-chat-feed-scrollbar]')) {
			expect(scrollbar.className).not.toContain('invisible');
		}
	});

	it('widens the draggable scrollbar for fine pointers', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'twenty-thousand',
		});
		const { scrollbar } = await showFeedScrollbar(container);

		expect(scrollbar.classList.contains('w-1.5')).toBe(true);
		expect(scrollbar.classList.contains('pointer-fine:w-3')).toBe(true);
	});

	it('auto-hides after scrolling while retaining the track and viewport', async () => {
		const onUserScrollIntent = vi.fn();
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'twenty-thousand',
			onUserScrollIntent,
		});
		const { scrollbar, viewport } = await showFeedScrollbar(container);
		expect(scrollbar.dataset.state).toBe('hidden');
		viewport.scrollTop = 100;
		await fireEvent.scroll(viewport);
		expect(scrollbar.dataset.state).toBe('visible');
		await waitFor(() => expect(scrollbar.dataset.state).toBe('hidden'), { timeout: 1_500 });
		expect(scrollbar.isConnected).toBe(true);
		expect(onUserScrollIntent).not.toHaveBeenCalled();

		const beforePreferenceChange = viewport.scrollTop;
		const newValue = JSON.stringify({ autoHideChatScrollbar: false });
		localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, newValue);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.localSettings,
				newValue,
				storageArea: localStorage,
			}),
		);
		await tick();
		expect(container.querySelector('[data-chat-scrollbar-auto-hide="false"]')).not.toBeNull();
		expect(container.querySelector('[data-chat-scroll-viewport]')).toBe(viewport);
		expect(viewport.scrollTop).toBe(beforePreferenceChange);
		expect(onUserScrollIntent).not.toHaveBeenCalled();
	});

	it('reports an immediate scrollbar track jump from its committed offset', async () => {
		let feedViewport: HTMLElement | null = null;
		const observedScrollTops: number[] = [];
		const onUserScrollIntent = vi.fn(() => observedScrollTops.push(feedViewport?.scrollTop ?? -1));
		const { container } = render(ConversationFeedTestHost, {
			onUserScrollIntent,
			transcriptScenario: 'twenty-thousand',
		});
		const { scrollbar, thumb, viewport } = await showFeedScrollbar(container);
		feedViewport = viewport;
		viewport.scrollTop = 500;
		vi.spyOn(thumb, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 120 } as DOMRect);
		document.addEventListener('pointerdown', () => (viewport.scrollTop = 0), { once: true });

		await fireEvent.pointerDown(scrollbar, { button: 0, clientY: 90, pointerId: 1 });

		expect(onUserScrollIntent.mock.calls).toEqual([['earlier']]);
		expect(observedScrollTops).toEqual([500]);
		expect(viewport.scrollTop).toBe(0);
	});

	it('reports wheel direction over the custom scrollbar before it scrolls', async () => {
		let feedViewport: HTMLElement | null = null;
		const observedScrollTops: number[] = [];
		const onUserScrollIntent = vi.fn(() => observedScrollTops.push(feedViewport?.scrollTop ?? -1));
		const { container } = render(ConversationFeedTestHost, {
			onUserScrollIntent,
			transcriptScenario: 'twenty-thousand',
		});
		const { scrollbar, viewport } = await showFeedScrollbar(container);
		feedViewport = viewport;
		viewport.scrollTop = 500;
		document.addEventListener('wheel', () => (viewport.scrollTop = 0), { once: true });

		await fireEvent.wheel(scrollbar, { deltaY: -40 });
		expect(viewport.scrollTop).toBe(0);
		viewport.scrollTop = 500;
		await fireEvent.wheel(scrollbar, { deltaY: 40 });

		expect(onUserScrollIntent.mock.calls).toEqual([['earlier'], ['later']]);
		expect(observedScrollTops).toEqual([500, 500]);
	});

	it('defers thumb pickup until pointer movement establishes direction', async () => {
		const onUserScrollIntent = vi.fn();
		const { container } = render(ConversationFeedTestHost, {
			onUserScrollIntent,
			transcriptScenario: 'twenty-thousand',
		});
		const { thumb, viewport } = await showFeedScrollbar(container);
		viewport.scrollTop = 500;
		thumb.addEventListener('pointerdown', () => (viewport.scrollTop = 499.5), { once: true });

		await fireEvent.pointerDown(thumb, { button: 0, clientY: 100, pointerId: 2 });
		expect(onUserScrollIntent.mock.calls).toEqual([[null]]);
		await fireEvent.pointerMove(thumb, { buttons: 1, clientY: 80, pointerId: 2 });
		await fireEvent.pointerMove(thumb, { buttons: 1, clientY: 120, pointerId: 2 });
		await fireEvent.pointerUp(thumb, { button: 0, clientY: 120, pointerId: 2 });

		expect(onUserScrollIntent.mock.calls).toEqual([[null], ['earlier'], ['later']]);
	});

	it('keeps the automatic earlier-history boundary out of the transcript', () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'local-truncation',
		});

		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
		expect(container.querySelector('[data-transcript-page-boundary="earlier"]')).toBeNull();
	});

	it('shows automatic earlier loading outside virtual geometry', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'loading-earlier',
		});
		const viewport = screen.getByRole('region', { name: 'Chat messages' });
		await ready();
		const indicator = container.querySelector<HTMLElement>('[data-chat-earlier-loading-indicator]');

		expect(indicator?.textContent).toContain('Loading earlier messages...');
		expect(indicator?.classList.contains('top-2')).toBe(true);
		expect(indicator?.classList.contains('left-1/2')).toBe(true);
		expect(indicator?.classList.contains('-translate-x-1/2')).toBe(true);
		expect(indicator?.classList.contains('size-8')).toBe(true);
		expect(indicator?.classList.contains('rounded-full')).toBe(true);
		expect(indicator?.classList.contains('border')).toBe(true);
		expect(indicator?.classList.contains('bg-background')).toBe(true);
		expect(indicator?.classList.contains('shadow-none')).toBe(true);
		expect(indicator?.classList.contains('inset-x-0')).toBe(false);
		expect(screen.getByText('Loading earlier messages...').classList.contains('sr-only')).toBe(
			true,
		);
		expect(indicator?.closest('[data-chat-virtual-sizer]')).toBeNull();
		expect(viewport.contains(indicator)).toBe(false);
		expect(viewport.getAttribute('aria-busy')).toBe('true');
		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
		expect(container.querySelector('[data-transcript-page-boundary="earlier"]')).toBeNull();
	});

	it('renders later loading below the transcript without a native bottom anchor', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'loading-later',
		});
		await ready();
		const transcript = container.querySelector('[data-chat-row-id]');
		const boundary = container.querySelector('[data-transcript-page-boundary="later"]');

		expect(await screen.findByText('Loading later messages...')).toBeTruthy();
		expect(screen.getByRole('region', { name: 'Chat messages' }).getAttribute('aria-busy')).toBe(
			'true',
		);
		expect(transcript?.compareDocumentPosition(boundary as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(container.querySelector('[data-chat-bottom-anchor]')).toBeNull();
	});

	it('keeps an earlier failure in flow as a directional retry', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'error-earlier',
		});
		await ready();
		const retry = await screen.findByRole('button', { name: 'Retry earlier messages' });
		const boundary = container.querySelector('[data-transcript-page-boundary="earlier"]');
		const transcript = container.querySelector('[data-chat-row-id]');
		if (!boundary || !transcript) throw new Error('Expected the earlier boundary and transcript');

		expect(boundary.compareDocumentPosition(transcript)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		await fireEvent.click(retry);

		const loading = await screen.findByRole('button', { name: 'Loading earlier messages...' });
		expect(loading.getAttribute('aria-busy')).toBe('true');
		expect(container.querySelector('[data-transcript-page-boundary="earlier"]')).toBe(boundary);
		expect(container.querySelector('[data-chat-earlier-loading-indicator]')).toBeNull();
	});

	it('passes durable and optimistic row identities to mounted virtual rows', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });

		await waitFor(() =>
			expect(
				Array.from(
					container.querySelectorAll<HTMLElement>('[data-chat-row-id]'),
					(row) => row.dataset.chatRowId,
				),
			).toEqual(['generation-1:1', 'optimistic:message-1']),
		);
	});

	it('uses a non-live browsing region and a stable dedicated announcer', () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });
		const viewport = screen.getByRole('region', { name: 'Chat messages' });
		const announcer = container.querySelector('[role="status"]');

		expect(viewport.getAttribute('aria-live')).toBe('off');
		expect(announcer?.getAttribute('aria-live')).toBe('polite');
		expect(announcer?.closest('[data-chat-virtual-sizer]')).toBeNull();
	});

	it('publishes a fresh live-region executor for repeated identical announcements', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'row-ids',
			showAnnouncementTrigger: true,
		});
		const status = container.querySelector<HTMLElement>('[role="status"]');
		const button = screen.getByRole('button', { name: 'Announce' });

		await fireEvent.click(button);
		await waitFor(() => expect(status?.textContent).toBe('Repeated update'));
		const firstNode = status?.firstElementChild;
		const firstSequence = status?.dataset.chatFeedAnnouncementSequence;
		await fireEvent.click(button);
		await waitFor(() =>
			expect(status?.dataset.chatFeedAnnouncementSequence).not.toBe(firstSequence),
		);

		expect(status?.textContent).toBe('Repeated update');
		expect(status?.firstElementChild).not.toBe(firstNode);
	});

	it('renders a bounded virtual range instead of every loaded transcript row', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'local-truncation',
		});
		await ready();
		const mountedItems = container.querySelectorAll('[data-chat-virtual-item]').length;
		const mountedTranscriptRows = container.querySelectorAll('[data-chat-row-id]').length;
		expect(mountedItems).toBeGreaterThan(0);
		expect(mountedTranscriptRows).toBeGreaterThan(0);
		expect(mountedItems).toBeLessThan(120);
		expect(container.querySelector('[data-chat-virtual-sizer]')).toBeTruthy();
	});

	it('bounds a twenty-thousand-entry payload before virtual projection', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'twenty-thousand',
		});
		await waitFor(
			() => {
				const sizer = container.querySelector('[data-chat-virtual-sizer]');
				expect(Number(sizer?.getAttribute('data-chat-transcript-entry-count'))).toBeGreaterThan(0);
				expect(Number(sizer?.getAttribute('data-chat-transcript-entry-count'))).toBeLessThanOrEqual(50);
				expect(Number(sizer?.getAttribute('data-chat-virtual-model-count'))).toBeLessThanOrEqual(54);
				const mountedItems = container.querySelectorAll('[data-chat-virtual-item]').length;
				const mountedTranscriptRows = container.querySelectorAll('[data-chat-row-id]').length;
				expect(mountedItems).toBeGreaterThan(0);
				expect(mountedTranscriptRows).toBeGreaterThan(0);
				expect(mountedItems).toBeLessThan(60);
			},
			{ timeout: 10_000 },
		);
	});

	it('ignores a connected stale row measurement after the item count shrinks', async () => {
		vi.spyOn(DisplayWindowController.prototype, 'trim').mockImplementation(() => {});
		let staleRow: HTMLElement | null = null;
		try {
			const { container } = render(ConversationFeedTestHost, {
				transcriptScenario: 'count-shrink',
			});
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('53'),
			);
			await ready();
			const mountedRows = [
				...container.querySelectorAll<HTMLElement>('[data-chat-virtual-item]'),
			].filter((item) => item.querySelector('[data-chat-row-id]'));
			staleRow = mountedRows.at(-1) ?? null;
			if (!staleRow) throw new Error('Expected a measured virtual row');
			const staleIndex = Number(staleRow.dataset.index);
			expect(staleIndex).toBeGreaterThanOrEqual(22);
			const staleObserver = ResizeObserverHarness.instances.find((observer) =>
				observer.observed.has(staleRow as HTMLElement),
			);
			if (!staleObserver) throw new Error('Expected the stale row to be observed');
			ResizeObserverHarness.emitFrom(staleObserver, staleRow, 900, 240);

			await fireEvent.click(screen.getByRole('button', { name: 'Shrink transcript' }));
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('22'),
			);
			expect(staleRow.isConnected).toBe(false);
			document.body.append(staleRow);
			expect(staleRow.isConnected).toBe(true);
			ResizeObserverHarness.emitFrom(staleObserver, staleRow, 900, 10_000);

			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			await waitFor(() => {
				const indexes = [
					...container.querySelectorAll<HTMLElement>('[data-chat-virtual-item]'),
				].map((item) => Number(item.dataset.index));
				expect(indexes.length).toBeGreaterThan(0);
				expect(indexes.every((index) => index >= 0 && index < 22)).toBe(true);
				expect(
					Number.parseFloat(
						container.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.style.height ?? '0',
					),
				).toBeLessThan(10_000);
			});
		} finally {
			staleRow?.remove();
		}
	});

	it('preserves measured survivor geometry across count shrink and a later publication', async () => {
		vi.spyOn(DisplayWindowController.prototype, 'trim').mockImplementation(() => {});
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'count-shrink-survivors',
		});
		await waitFor(() =>
			expect(
				container
					.querySelector('[data-chat-virtual-sizer]')
					?.getAttribute('data-chat-virtual-model-count'),
			).toBe('53'),
		);
		await ready();
		const measuredRow = container
			.querySelector('[data-chat-row-id="generation-1:120"]')
			?.closest<HTMLElement>('[data-chat-virtual-item]');
		const followingRow = measuredRow?.nextElementSibling as HTMLElement | null;
		if (!measuredRow || !followingRow) {
			throw new Error('Expected the mounted tail row and end spacer');
		}
		const survivorKey = measuredRow.dataset.chatVirtualItem;
		expect(survivorKey).toBeTruthy();
		const viewport = container.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
		if (!viewport) throw new Error('Expected the Chat viewport');
		ResizeObserverHarness.emit(viewport, 900, 720);
		ResizeObserverHarness.emit(measuredRow, 900, 600);
		viewport.scrollTop += 37;
		await fireEvent.scroll(viewport);

		await fireEvent.click(screen.getByRole('button', { name: 'Shrink transcript keeping tail' }));
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'Show earlier error' }));
		await tick();
		await waitFor(() =>
			expect(
				container
					.querySelector('[data-chat-virtual-sizer]')
					?.getAttribute('data-chat-virtual-model-count'),
			).toBe('23'),
		);
		expect(measuredRow.isConnected).toBe(true);
		expect(followingRow.isConnected).toBe(true);
		expect(measuredRow.dataset.chatVirtualItem).toBe(survivorKey);
		await waitFor(() => {
			const start = (element: HTMLElement): number =>
				Number(element.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? Number.NaN);
			expect(start(followingRow) - start(measuredRow)).toBe(600);
		});
	});

	it('updates Bash filtering from remote settings snapshots', async () => {
		const remoteSettingsStore = new RemoteSettingsStore();
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'bash-filter',
			remoteSettingsStore,
		});

		await waitFor(() => {
			expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(1);
		});

		remoteSettingsStore.applySnapshot(
			makeRemoteSettingsSnapshot({
				version: 1,
				ui: { hiddenBashCommandPatterns: [{ pattern: 'git *', mode: 'glob' }] },
			}),
		);
		await waitFor(() => {
			expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(0);
		});

		remoteSettingsStore.applySnapshot(
			makeRemoteSettingsSnapshot({
				version: 2,
				ui: { hiddenBashCommandPatterns: [] },
			}),
		);
		await waitFor(() => {
			expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(1);
		});
	});
});
