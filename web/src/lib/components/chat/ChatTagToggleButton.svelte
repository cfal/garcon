<script lang="ts">
	import Tag from '@lucide/svelte/icons/tag';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		active: boolean;
		onToggle: () => void;
	}

	let { active, onToggle }: Props = $props();
</script>

<button
	type="button"
	onclick={onToggle}
	class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	title={m.chat_new_chat_tags_add()}
	aria-label={m.chat_new_chat_tags_add()}
>
	<Tag class="size-4 shrink-0 {active ? 'text-primary' : 'text-muted-foreground'}" aria-hidden="true" />
</button>
