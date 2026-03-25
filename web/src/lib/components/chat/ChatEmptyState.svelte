<script lang="ts">
	// Empty-state panel shown when no chat is selected. Provides a CTA
	// to open the new-chat dialog.

	import { Button } from '$lib/components/ui/button';
	import { getAppShell } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const appShell = getAppShell();

	function openNewChat() {
		appShell.openNewChatDialog();
	}
</script>

<div class="h-full grid place-items-center px-6">
	<div class="max-w-md text-center space-y-4">
		<h2 class="text-xl font-semibold text-foreground">{m.chat_empty_no_chat_selected()}</h2>
		<p class="text-sm text-muted-foreground">{m.chat_empty_press_new_chat()}</p>
		<Button onclick={openNewChat}>{m.command_new_chat()}</Button>
	</div>
</div>
