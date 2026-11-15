<script lang="ts">
	import Tag from '@lucide/svelte/icons/tag';
	import Plus from '@lucide/svelte/icons/plus';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		active: boolean;
		label?: string;
		presentation?: 'compact' | 'session-row';
		open?: boolean;
		onToggle: () => void;
	}

	let { active, label, presentation = 'compact', open, onToggle }: Props = $props();
</script>

<button
	type="button"
	onclick={onToggle}
	class={[
		'inline-flex items-center gap-2 rounded-lg border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
		presentation === 'session-row'
			? 'h-11 w-full min-w-0 overflow-hidden bg-background px-4 hover:bg-accent'
			: 'min-h-11 px-3 py-2 text-sm hover:bg-muted/50',
	]}
	title={label ?? m.chat_new_chat_tags_add()}
	aria-label={label ?? m.chat_new_chat_tags_add()}
	aria-expanded={open}
>
	<Tag class="size-4 shrink-0 {active ? 'text-primary' : 'text-muted-foreground'}" aria-hidden="true" />
	{#if label || presentation === 'session-row'}
		<span class={presentation === 'session-row' ? 'min-w-0 flex-1 truncate text-left text-xs text-muted-foreground' : ''}>
			{label ?? m.chat_new_chat_tags_add()}
		</span>
	{/if}
	{#if presentation === 'session-row'}
		<span class="inline-flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
			<Plus class="size-4 text-muted-foreground" />
		</span>
	{/if}
</button>
