<script lang="ts">
	import Bot from '@lucide/svelte/icons/bot';
	import MenuValueLabel from '$lib/components/shared/MenuValueLabel.svelte';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages.js';

	let {
		selection,
		disabled,
		onSelect,
	}: { selection?: { summary: string; title: string }; disabled?: boolean; onSelect: () => void } = $props();
</script>

<DropdownMenuItem
	{onSelect}
	{disabled}
	title={selection?.title}
	textValue={m.chat_composer_model()}
	data-composer-control="model"
	class="group"
>
	<Bot class="size-4" />
	<MenuValueLabel label={m.chat_composer_model()} value={selection?.summary ?? ''} wrapValue />
</DropdownMenuItem>
