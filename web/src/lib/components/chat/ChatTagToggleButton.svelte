<script lang="ts">
	import Tag from '@lucide/svelte/icons/tag';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		active: boolean;
		label?: string;
		onToggle: () => void;
	}

	let { active, label, onToggle }: Props = $props();
</script>

<button
	type="button"
	onclick={onToggle}
	class="inline-flex min-h-11 items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	title={label ?? m.chat_new_chat_tags_add()}
	aria-label={label ?? m.chat_new_chat_tags_add()}
>
	<Tag class="w-4 h-4 {active ? 'text-primary' : 'text-muted-foreground'}" aria-hidden="true" />
	{#if label}<span>{label}</span>{/if}
</button>
