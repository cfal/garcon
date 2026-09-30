<script lang="ts">
	import Pencil from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button';
	import { getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { DEFAULT_TICKET_CHAT_PROMPT } from '$shared/ticket-chat';
	import GenerationPromptDialog from './GenerationPromptDialog.svelte';
	import type { GenerationPromptSaveResult } from './remote-generation-settings-card-state.svelte';

	const remoteSettings = getRemoteSettings();
	let promptDialogOpen = $state(false);

	async function savePrompt(customPrompt: string): Promise<GenerationPromptSaveResult> {
		try {
			await remoteSettings.update({ ui: { ticketChat: { customPrompt } } });
			promptDialogOpen = false;
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : m.settings_save_failed(),
			};
		}
	}
</script>

<div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
	<div class="text-sm font-medium text-foreground">{m.settings_ticket_chat_prompt()}</div>
	<Button
		variant="outline"
		size="sm"
		onclick={() => {
			promptDialogOpen = true;
		}}
	>
		<Pencil />
		{m.settings_ticket_chat_prompt_edit()}
	</Button>
</div>

{#if promptDialogOpen}
	<GenerationPromptDialog
		kind="ticket-chat"
		initialPrompt={remoteSettings.snapshot?.ui.ticketChat?.customPrompt ?? ''}
		defaultPrompt={DEFAULT_TICKET_CHAT_PROMPT}
		onSave={savePrompt}
		onCancel={() => {
			promptDialogOpen = false;
		}}
	/>
{/if}
