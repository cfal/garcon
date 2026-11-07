<script lang="ts">
	import { untrack } from 'svelte';
	import type { WorkspaceCoordinator } from '../workspace-coordinator.svelte';
	let {
		workspace,
		onChange,
	}: {
		workspace: WorkspaceCoordinator;
		onChange: (chatId: string | null) => void;
	} = $props();
	$effect(() => {
		const chatId = workspace.focusedChatId;
		untrack(() => onChange(chatId));
	});
</script>
