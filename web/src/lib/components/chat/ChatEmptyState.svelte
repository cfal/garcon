<script lang="ts">
	// Empty-state panel shown when no chat is selected. Provides a CTA
	// to open the new-chat dialog.

	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import { Button } from '$lib/components/ui/button';
	import { getAppShell, getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		formatGlobalShortcut,
		getEffectiveGlobalShortcut,
	} from '$lib/workspace/global-shortcuts.js';

	const appShell = getAppShell();
	const localSettings = getLocalSettings();

	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	const newChatShortcut = $derived.by(() => {
		const binding = getEffectiveGlobalShortcut('new-chat', localSettings.globalShortcuts ?? {});
		return binding ? formatGlobalShortcut(binding, isMac) : null;
	});

	function openNewChat() {
		appShell.openNewChatDialog();
	}
</script>

<div class="h-full grid place-items-center px-6">
	<div class="max-w-md text-center space-y-4">
		<div
			class="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-muted"
		>
			<MessageSquarePlus class="h-7 w-7 text-muted-foreground" />
		</div>
		<h2 class="text-xl font-semibold text-foreground">{m.chat_empty_no_chat_selected()}</h2>
		<p class="text-sm text-muted-foreground">{m.chat_empty_press_new_chat()}</p>
		<div class="space-y-2">
			<Button onclick={openNewChat}>{m.command_new_chat()}</Button>
			{#if newChatShortcut}
				<p
					class="hidden items-center justify-center gap-1 text-xs text-muted-foreground pointer-fine:flex"
				>
					{m.chat_empty_shortcut_hint()}
					{#each newChatShortcut as key, index (index)}
						{#if index > 0}
							<span>+</span>
						{/if}
						<kbd class="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded border border-border"
							>{key}</kbd
						>
					{/each}
				</p>
			{/if}
		</div>
	</div>
</div>
