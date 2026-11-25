import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MinuteClockStore } from '$lib/stores/minute-clock.svelte';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { ChatLineage } from '$shared/chat-parentage';
import { ChatMapController } from '$lib/chat-map/chat-map-controller.svelte';
import * as m from '$lib/paraglide/messages.js';
import ChatMapPanel from '../ChatMapPanel.svelte';

vi.mock('$lib/context', async (original) => ({
	...(await original<typeof import('$lib/context')>()),
	getMinuteClock: () => ({ currentTime: new Date() } satisfies Pick<MinuteClockStore, 'currentTime'>),
}));

afterEach(cleanup);

function parent(sourceChatId: string, kind: ChatLineage['kind'] = 'fork'): ChatLineage {
	return { sourceChatId, kind, transcriptViewId: `view-${sourceChatId}`, ordinal: 1 };
}

function chat(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id,
		parentChatId: null,
		lineage: null,
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title: `Chat ${id}`,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-08-30T12:00:00.000Z',
		lastActivityAt: '2026-08-30T13:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		activityStatus: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: null,
		tags: [],
		...overrides,
	};
}

function renderPanel(
	chats: readonly ChatSessionRecord[],
	options: { selectedChatId?: string | null; controller?: ChatMapController } = {},
) {
	const controller = options.controller ?? new ChatMapController();
	const rendered = render(ChatMapPanel, {
		controller,
		chats,
		selectedChatId: options.selectedChatId ?? null,
		visible: true,
		presentation: 'window-main',
	});
	return { ...rendered, controller };
}

describe('ChatMapPanel', () => {
	it('keeps hidden topology dormant and reconciles once when shown', async () => {
		const initial = [chat('parent'), chat('child', { lineage: parent('parent') })];
		const { controller, rerender } = renderPanel(initial);
		controller.collapseAll(['chat:parent']);
		await rerender({ visible: false });
		await rerender({ chats: [chat('replacement')] });
		expect(controller.collapsedNodeKeys.has('chat:parent')).toBe(true);
		expect(screen.queryByRole('link', { name: /Chat replacement/ })).toBeNull();
		await rerender({ visible: true });
		expect(controller.collapsedNodeKeys.size).toBe(0);
		expect(screen.getByRole('link', { name: /Chat replacement/ })).toBeTruthy();
	});

	it('reclaims hidden branches and restores scroll, query, and collapsed nodes', async () => {
		const chats = [chat('parent'), chat('child', { lineage: parent('parent') })];
		const view = renderPanel(chats);
		view.controller.collapseAll(['chat:parent']);
		view.controller.setQuery('parent');
		const region = view.container.querySelector('[data-chat-map-scroll-region]')!;
		await fireEvent.scroll(region, { target: { scrollTop: 120, scrollLeft: 80 } });
		await view.rerender({ visible: false });
		expect(view.container.querySelector('[data-chat-map-panel]')).toBeNull();
		await view.rerender({ chats: [...chats, chat('another')] });
		expect(view.controller.collapsedNodeKeys).toEqual(new Set(['chat:parent']));
		await view.rerender({ visible: true });
		expect(view.container.querySelector('[data-chat-map-scroll-region]')?.scrollTop).toBe(120);
		expect(view.container.querySelector('[data-chat-map-scroll-region]')?.scrollLeft).toBe(80);
		expect(view.controller.query).toBe('parent');
		expect(screen.getByRole('link', { name: /Chat parent/ })).toBeTruthy();
	});
	it('renders semantic nested lists with ordinary chat links and current state', () => {
		const { container } = renderPanel(
			[
				chat('parent', { title: 'Parent work' }),
				chat('child', {
					title: 'Child work',
					lineage: parent('parent'),
					model: 'opus',
					projectPath: '/workspace/very/long/project',
					isProcessing: true,
					processingPhase: 'running',
					isUnread: true,
					isArchived: true,
				}),
				chat('delegate', {
					title: 'Delegated review',
					parentChatId: 'child',
					agentId: 'codex',
				}),
			],
			{ selectedChatId: 'child' },
		);

		const map = screen.getByRole('list', { name: m.workspace_surface_chat_map() });
		const parentLink = within(map).getByRole('link', { name: /Parent work/ });
		const childLink = within(map).getByRole('link', { name: /Child work/ });
		const delegateLink = within(map).getByRole('link', { name: /Delegated review/ });
		expect(parentLink.getAttribute('href')).toBe('/chat/parent');
		expect(childLink.getAttribute('href')).toBe('/chat/child');
		expect(childLink.getAttribute('aria-current')).toBe('page');
		expect(childLink.closest('li')?.parentElement?.closest('li')).toBe(parentLink.closest('li'));
		expect(delegateLink.closest('li')?.parentElement).toBe(map);
		expect(within(childLink).getByText(m.chat_map_relation_fork()).classList).toContain(
			'text-foreground',
		);
		expect(within(childLink).getByText('claude').classList).toContain('text-foreground');
		expect(within(childLink).getByText('opus')).toBeTruthy();
		expect(within(delegateLink).queryByText(m.chat_map_relation_fork())).toBeNull();
		expect(within(childLink).getByText(m.chat_map_status_processing())).toBeTruthy();
		expect(within(childLink).getByText(m.chat_map_status_unread())).toBeTruthy();
		expect(within(childLink).getByText(m.chat_map_status_archived())).toBeTruthy();
		expect(childLink.querySelector('time')?.getAttribute('datetime')).toBe(
			'2026-08-30T13:00:00.000Z',
		);
		expect(container.querySelector('[role="tree"]')).toBeNull();
		expect(screen.getByText(m.chat_map_chat_count({ count: 3 })).classList).toContain(
			'text-foreground',
		);
		expect(screen.getByText(m.chat_map_root_count({ count: 2 })).classList).toContain(
			'text-foreground',
		);
	});

	it('collapses and expands a branch with accessible disclosure state', async () => {
		renderPanel([chat('parent'), chat('child', { lineage: parent('parent') })]);
		expect(
			screen.getByRole('button', { name: m.chat_map_expand_all() }).getAttribute('aria-label'),
		).toBe(m.chat_map_expand_all());
		expect(
			screen.getByRole('button', { name: m.chat_map_collapse_all() }).getAttribute('aria-label'),
		).toBe(m.chat_map_collapse_all());
		const collapse = screen.getByRole('button', {
			name: m.chat_map_collapse_branch({ title: 'Chat parent' }),
		});

		expect(collapse.getAttribute('aria-expanded')).toBe('true');
		await fireEvent.click(collapse);
		expect(screen.queryByRole('link', { name: /Chat child/ })).toBeNull();

		const expand = screen.getByRole('button', {
			name: m.chat_map_expand_branch({ title: 'Chat parent' }),
		});
		expect(expand.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(expand);
		expect(screen.getByRole('link', { name: /Chat child/ })).toBeTruthy();
	});

	it('prunes stale collapse keys when the rendered topology changes', async () => {
		const initialChats = [
			chat('parent'),
			chat('child', { lineage: parent('parent') }),
			chat('other'),
			chat('other-child', { lineage: parent('other') }),
		];
		const { controller, rerender } = renderPanel(initialChats);
		controller.collapseAll(['chat:parent', 'chat:other']);

		await rerender({ chats: initialChats.filter((entry) => entry.id !== 'parent') });

		expect(controller.collapsedNodeKeys).toEqual(new Set(['chat:other']));
	});

	it('searches metadata, preserves ancestors as context, and reports zero results', async () => {
		const { container } = renderPanel([
			chat('root', { title: 'Root context' }),
			chat('match', { title: 'Target work', lineage: parent('root') }),
			chat('other', { title: 'Other work', lineage: parent('root') }),
		]);
		const search = screen.getByRole('searchbox', { name: m.chat_map_search_label() });

		expect(search.classList).toContain('text-base');
		await fireEvent.input(search, { target: { value: 'Target work' } });
		expect(screen.getByRole('link', { name: /Root context/ })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Target work/ })).toBeTruthy();
		expect(screen.queryByRole('link', { name: /Other work/ })).toBeNull();
		expect(container.querySelector('[data-chat-map-context="true"]')).toBeTruthy();

		await fireEvent.input(search, { target: { value: 'nothing matches' } });
		expect(screen.getByText(m.chat_map_no_results_title())).toBeTruthy();
	});

	it('renders shared unavailable-source and cycle warnings', () => {
		const { container } = renderPanel([
			chat('dangling-a', { lineage: parent('gone') }),
			chat('dangling-b', { lineage: parent('gone', 'handoff') }),
			chat('cycle', { lineage: parent('cycle') }),
		]);

		expect(container.querySelectorAll('[data-chat-map-missing-parent="gone"]')).toHaveLength(1);
		expect(screen.getByText('Source unavailable')).toBeTruthy();
		expect(screen.getByText('Referenced source gone is not available.')).toBeTruthy();
		expect(screen.getByText('1 unavailable sources')).toBeTruthy();
		expect(screen.getAllByText(m.chat_map_cycle_warning()).length).toBeGreaterThan(0);
		expect(screen.getByText(m.chat_map_relation_handoff())).toBeTruthy();
	});

	it('renders an empty state when no persisted chats are visible', () => {
		renderPanel([chat('draft', { status: 'draft' })]);

		expect(screen.getByText(m.chat_map_empty_title())).toBeTruthy();
		expect(screen.queryByRole('list', { name: m.workspace_surface_chat_map() })).toBeNull();
	});
});
