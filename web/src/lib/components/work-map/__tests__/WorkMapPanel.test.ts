import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatParentRelation, ParentChatRef } from '$shared/chat-parentage';
import { WorkMapController } from '$lib/work-map/work-map-controller.svelte';
import * as m from '$lib/paraglide/messages.js';
import WorkMapPanel from '../WorkMapPanel.svelte';

afterEach(cleanup);

function parent(chatId: string, relation: ChatParentRelation = 'fork'): ParentChatRef {
	return relation === 'delegation'
		? { chatId, relation }
		: { chatId, relation, transcriptViewId: `view-${chatId}`, ordinal: 4 };
}

function chat(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
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
	options: { selectedChatId?: string | null; controller?: WorkMapController } = {},
) {
	const controller = options.controller ?? new WorkMapController();
	const rendered = render(WorkMapPanel, {
		controller,
		chats,
		selectedChatId: options.selectedChatId ?? null,
		visible: false,
		presentation: 'window-main',
	});
	return { ...rendered, controller };
}

describe('WorkMapPanel', () => {
	it('renders semantic nested lists with ordinary chat links and current state', () => {
		const { container } = renderPanel(
			[
				chat('parent', { title: 'Parent work' }),
				chat('child', {
					title: 'Child work',
					parentChat: parent('parent'),
					model: 'opus',
					projectPath: '/workspace/very/long/project',
					isProcessing: true,
					processingPhase: 'running',
					isUnread: true,
					isArchived: true,
				}),
				chat('delegate', {
					title: 'Delegated review',
					parentChat: parent('child', 'delegation'),
					agentId: 'codex',
				}),
			],
			{ selectedChatId: 'child' },
		);

		const map = screen.getByRole('list', { name: m.workspace_surface_work_map() });
		const parentLink = within(map).getByRole('link', { name: /Parent work/ });
			const childLink = within(map).getByRole('link', { name: /Child work/ });
			const delegateLink = within(map).getByRole('link', { name: /Delegated review/ });
		expect(parentLink.getAttribute('href')).toBe('/chat/parent');
		expect(childLink.getAttribute('href')).toBe('/chat/child');
		expect(childLink.getAttribute('aria-current')).toBe('page');
			expect(childLink.closest('li')?.parentElement?.closest('li')).toBe(parentLink.closest('li'));
			expect(delegateLink.closest('li')?.parentElement?.closest('li')).toBe(childLink.closest('li'));
		expect(
			within(childLink).getByText(m.work_map_relation_fork()).classList,
		).toContain('text-foreground');
		expect(within(childLink).getByText('claude').classList).toContain('text-foreground');
			expect(within(childLink).getByText('opus')).toBeTruthy();
			expect(within(delegateLink).getByText(m.work_map_relation_delegation())).toBeTruthy();
		expect(within(childLink).getByText(m.work_map_status_processing())).toBeTruthy();
		expect(within(childLink).getByText(m.work_map_status_unread())).toBeTruthy();
		expect(within(childLink).getByText(m.work_map_status_archived())).toBeTruthy();
		expect(container.querySelector('[role="tree"]')).toBeNull();
			expect(screen.getByText(m.work_map_chat_count({ count: 3 })).classList).toContain(
			'text-foreground',
		);
		expect(screen.getByText(m.work_map_root_count({ count: 1 })).classList).toContain(
			'text-foreground',
		);
	});

	it('collapses and expands a branch with accessible disclosure state', async () => {
		renderPanel([chat('parent'), chat('child', { parentChat: parent('parent') })]);
		expect(
			screen.getByRole('button', { name: m.work_map_expand_all() }).getAttribute('aria-label'),
		).toBe(m.work_map_expand_all());
		expect(
			screen.getByRole('button', { name: m.work_map_collapse_all() }).getAttribute('aria-label'),
		).toBe(m.work_map_collapse_all());
		const collapse = screen.getByRole('button', {
			name: m.work_map_collapse_branch({ title: 'Chat parent' }),
		});

		expect(collapse.getAttribute('aria-expanded')).toBe('true');
		await fireEvent.click(collapse);
		expect(screen.queryByRole('link', { name: /Chat child/ })).toBeNull();

		const expand = screen.getByRole('button', {
			name: m.work_map_expand_branch({ title: 'Chat parent' }),
		});
		expect(expand.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(expand);
		expect(screen.getByRole('link', { name: /Chat child/ })).toBeTruthy();
	});

	it('searches metadata, preserves ancestors as context, and reports zero results', async () => {
		const { container } = renderPanel([
			chat('root', { title: 'Root context' }),
			chat('match', { title: 'Target work', parentChat: parent('root') }),
			chat('other', { title: 'Other work', parentChat: parent('root') }),
		]);
		const search = screen.getByRole('searchbox', { name: m.work_map_search_label() });

		expect(search.classList).toContain('text-base');
		await fireEvent.input(search, { target: { value: 'Target work' } });
		expect(screen.getByRole('link', { name: /Root context/ })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Target work/ })).toBeTruthy();
		expect(screen.queryByRole('link', { name: /Other work/ })).toBeNull();
		expect(container.querySelector('[data-work-map-context="true"]')).toBeTruthy();

		await fireEvent.input(search, { target: { value: 'nothing matches' } });
		expect(screen.getByText(m.work_map_no_results_title())).toBeTruthy();
	});

	it('renders shared unavailable-parent and cycle warnings', () => {
		const { container } = renderPanel([
			chat('dangling-a', { parentChat: parent('gone') }),
			chat('dangling-b', { parentChat: parent('gone', 'handoff') }),
			chat('cycle', { parentChat: parent('cycle') }),
		]);

		expect(container.querySelectorAll('[data-work-map-missing-parent="gone"]')).toHaveLength(1);
		expect(screen.getAllByText(m.work_map_cycle_warning()).length).toBeGreaterThan(0);
		expect(screen.getByText(m.work_map_relation_handoff())).toBeTruthy();
	});

	it('renders an empty state when no persisted chats are visible', () => {
		renderPanel([chat('draft', { status: 'draft' })]);

		expect(screen.getByText(m.work_map_empty_title())).toBeTruthy();
		expect(screen.queryByRole('list', { name: m.workspace_surface_work_map() })).toBeNull();
	});
});
