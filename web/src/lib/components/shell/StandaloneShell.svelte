<script lang="ts">
	// Thin wrapper around Shell for use as the standalone Shell tab.

	import Shell from './Shell.svelte';

	interface StandaloneShellProps {
		initialPath: string;
		chatId: string;
	}

	let {
		initialPath,
		chatId
	}: StandaloneShellProps = $props();
</script>

<div class="h-full w-full flex flex-col">
	<div class="flex-1 w-full min-h-0">
		<Shell projectPath={initialPath} {chatId} />
	</div>
</div>
