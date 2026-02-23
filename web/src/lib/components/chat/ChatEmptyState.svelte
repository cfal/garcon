<script lang="ts">
	// Empty-state panel shown when no chat is selected. Provides a CTA
	// to open the new-chat dialog.

	import { Button } from '$lib/components/ui/button';
	import { getAppShell } from '$lib/context';

	const appShell = getAppShell();

	function openNewChat() {
		appShell.openNewChatDialog();
	}
</script>

<div class="h-full grid place-items-center px-6">
	<div class="max-w-md text-center space-y-4">
		<h2 class="text-xl font-semibold text-foreground">No chat selected</h2>
		<p class="text-sm text-muted-foreground">Press New Chat to start.</p>
		<Button onclick={openNewChat}>New Chat</Button>
	</div>
</div>
