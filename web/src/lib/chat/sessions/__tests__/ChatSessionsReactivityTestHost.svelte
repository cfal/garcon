<script lang="ts">
	import type { ChatSessionRecord } from '$lib/types/chat-session.js';
	import { buildSidebarDisplayChatIds } from '$lib/components/sidebar/sidebar-row-model.js';
	import { ChatSessionsStore } from '../chat-sessions.svelte.js';

	function chat(id: string, title: string): ChatSessionRecord {
		return {
			id,
			parentChat: null,
			projectPath: '/workspace/project',
			effectiveProjectKey: '/workspace/project',
			projectIdentityState: 'available',
			orderGroup: 'normal',
			title,
			agentId: 'claude',
			model: 'sonnet',
			permissionMode: 'default',
			thinkingMode: 'low',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			createdAt: '2026-09-06T10:00:00.000Z',
			lastActivityAt: '2026-09-06T10:00:00.000Z',
			lastReadAt: '2026-09-06T10:00:00.000Z',
			isPinned: false,
			isArchived: false,
			isProcessing: false,
			processingPhase: null,
			canReloadFromNativeHistory: false,
			isUnread: false,
			status: 'running',
			agentOwnershipEpoch: null,
			lastMessage: '',
			tags: [],
		};
	}

	const sessions = new ChatSessionsStore();
	const alpha = chat('alpha', 'Alpha');
	sessions.byId = { alpha };
	sessions.order = ['alpha'];
	sessions.setSelectedChatId('alpha');

	let sidebarIds = $derived(
		buildSidebarDisplayChatIds({
			displayedChats: sessions.orderedChats,
			grouping: 'none',
			currentTime: new Date('2026-09-06T12:00:00.000Z'),
			inactivityDuration: '3-days',
			sortMode: 'manual',
			pinnedInsertPosition: 'top',
		}),
	);

	function replaceCollections(): void {
		const beta = chat('beta', 'Beta');
		sessions.byId = {
			alpha: { ...alpha, title: 'Alpha updated', isUnread: true },
			beta,
		};
		sessions.order = ['beta', 'alpha'];
	}
</script>

<span data-testid="selected-title">{sessions.selectedChat?.title}</span>
<span data-testid="selected-unread">{sessions.selectedChat?.isUnread}</span>
<span data-testid="ordered-ids">{sessions.orderedChats.map((chat) => chat.id).join(',')}</span>
<span data-testid="sidebar-ids">{sidebarIds.join(',')}</span>
<button type="button" onclick={replaceCollections}>Replace collections</button>
