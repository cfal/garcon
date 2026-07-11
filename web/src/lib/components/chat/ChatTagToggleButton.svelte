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
	class="px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted/50 transition-colors"
	title={m.chat_new_chat_tags_add()}
	aria-label={m.chat_new_chat_tags_add()}
>
	<Tag class="w-4 h-4 {active ? 'text-primary' : 'text-muted-foreground'}" aria-hidden="true" />
</button>
