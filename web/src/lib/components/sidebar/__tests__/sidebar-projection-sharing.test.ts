import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import SidebarHost from './SidebarHost.svelte';

const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock('../sidebar-row-model', async (importOriginal) => {
	const original = await importOriginal<typeof import('../sidebar-row-model')>();
	return {
		...original,
		buildSidebarChatListProjection: (
			...args: Parameters<typeof original.buildSidebarChatListProjection>
		) => {
			builds.count += 1;
			return original.buildSidebarChatListProjection(...args);
		},
		buildSidebarRowModel: (...args: Parameters<typeof original.buildSidebarRowModel>) => {
			builds.count += 1;
			return original.buildSidebarRowModel(...args);
		},
	};
});

const chat = {
	id: 'synthetic-chat-1',
	projectPath: '/workspace/project',
	orderGroup: 'normal',
	title: 'Synthetic first chat',
	agentId: 'claude',
	model: 'sonnet',
	permissionMode: 'default',
	thinkingMode: 'none',
	agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
	createdAt: '2025-01-01T00:00:00.000Z',
	lastActivityAt: '2025-01-01T00:00:00.000Z',
	lastReadAt: null,
	isPinned: false,
	isArchived: false,
	isProcessing: false,
	processingPhase: null,
	isUnread: true,
	canReloadFromNativeHistory: false,
	status: 'draft',
	lastMessage: '',
	firstMessage: '',
	tags: [],
	parentChat: null,
	agentOwnershipEpoch: null,
} satisfies ChatSessionRecord;

afterEach(cleanup);

it('shares one row projection after a chat is created or deleted', async () => {
	const view = render(SidebarHost, {
		chats: [chat],
		sidebarGrouping: 'none',
		autoLoadSavedSearches: false,
	});
	expect(screen.getByText(chat.title)).toBeTruthy();
	await tick();
	await tick();
	builds.count = 0;
	const added = { ...chat, id: 'synthetic-chat-2', title: 'Synthetic second chat' };
	await view.rerender({ chats: [chat, added] });
	expect(screen.getByText(added.title)).toBeTruthy();
	expect(builds.count).toBe(1);
	builds.count = 0;
	await view.rerender({ chats: [added] });
	expect(screen.queryByText(chat.title)).toBeNull();
	expect(builds.count).toBe(1);
});
