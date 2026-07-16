<!-- Read-only reference of keyboard shortcuts and composer slash commands. -->
<script lang="ts">
	import { getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { GLOBAL_SHORTCUTS, SLASH_COMMANDS } from './keyboard-shortcut-entries.js';

	const ls = getLocalSettings();

	// Mirrors the submit gate in composer-shortcuts.ts, which flips between
	// Enter and Shift+Enter based on the local sendByShiftEnter preference.
	const sendMessageKeys = $derived(ls.sendByShiftEnter ? ['Shift', 'Enter'] : ['Enter']);
</script>

{#snippet keyCombo(keys: string[])}
	<span class="flex items-center gap-1">
		{#each keys as key, index (index)}
			{#if index > 0}
				<span class="text-xs text-muted-foreground">+</span>
			{/if}
			<kbd
				class="px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
			>
				{key}
			</kbd>
		{/each}
	</span>
{/snippet}

{#snippet shortcutRow(label: string, keys: string[])}
	<div class="flex items-center justify-between gap-4 py-2">
		<div class="text-sm font-medium text-foreground">{label}</div>
		{@render keyCombo(keys)}
	</div>
{/snippet}

<div class="space-y-6">
	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_global()}
		</h3>
		<div class="bg-muted/50 border border-border rounded-lg px-4 py-1">
			{#each GLOBAL_SHORTCUTS as entry (entry.label)}
				{@render shortcutRow(entry.label(), entry.keys)}
			{/each}
		</div>
	</section>

	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_composer()}
		</h3>
		<div class="bg-muted/50 border border-border rounded-lg px-4 py-1">
			{@render shortcutRow(m.settings_shortcut_send_message(), sendMessageKeys)}
		</div>
	</section>

	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_slash_commands()}
		</h3>
		<div class="bg-muted/50 border border-border rounded-lg px-4 py-1">
			{#each SLASH_COMMANDS as entry (entry.command)}
				<div
					class="flex flex-col items-start gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
				>
					<div class="text-sm text-muted-foreground">{entry.description()}</div>
					<code
						class="max-w-full whitespace-nowrap px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
					>
						{entry.command}
					</code>
				</div>
			{/each}
		</div>
	</section>
</div>
