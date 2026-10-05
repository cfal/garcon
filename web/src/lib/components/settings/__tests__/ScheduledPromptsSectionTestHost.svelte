<script lang="ts">
	import { untrack } from 'svelte';
	import ScheduledPromptsSection from '../ScheduledPromptsSection.svelte';
	import { setChatSessions, setScheduledPrompts } from '$lib/context';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
	import { ScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte';
	import type { ChatListEntry } from '$shared/chat-list';
	import type { ExecutorSnapshot } from '$shared/executors';
	import type { ScheduledPrompt, ScheduledPromptRunLogEntry } from '$shared/scheduled-prompts';

	let {
		executors,
		prompts,
		chats,
		runLog = [],
		onOpenChat = () => {},
	}: {
		executors: readonly ExecutorSnapshot[];
		prompts: ScheduledPrompt[];
		chats: ChatListEntry[];
		runLog?: ScheduledPromptRunLogEntry[];
		onOpenChat?: (chatId: string) => void;
	} = $props();

	setExecutorsTestContext(untrack(() => executors));
	const scheduledPrompts = new ScheduledPromptsStore();
	scheduledPrompts.applySnapshot({
		revision: 1,
		prompts: untrack(() => prompts),
		runLog: untrack(() => runLog),
	});
	setScheduledPrompts(scheduledPrompts);
	const sessions = new ChatSessionsStore();
	for (const chat of untrack(() => chats)) sessions.upsertServerChat(chat);
	setChatSessions(sessions);
</script>

<ScheduledPromptsSection active={true} {onOpenChat} />
