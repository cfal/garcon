<script lang="ts">
	import { untrack } from 'svelte';
	import SharedChatPage from '../SharedChatPage.svelte';
	import { setAppTitle, setChatSessions } from '$lib/context';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { createAppTitleStore } from '$lib/stores/app-title.svelte';

	interface Props {
		token?: string;
		chatTitles?: Record<string, string>;
	}

	let { token = 'share-token', chatTitles = {} }: Props = $props();
	setAppTitle(createAppTitleStore());

	const sessions = createChatSessionsStore();
	for (const [chatId, title] of Object.entries(untrack(() => chatTitles))) {
		sessions.createDraft({
			id: chatId,
			projectPath: '/workspace/project',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: title,
			},
		});
	}
	setChatSessions(sessions);
</script>

<SharedChatPage {token} />
