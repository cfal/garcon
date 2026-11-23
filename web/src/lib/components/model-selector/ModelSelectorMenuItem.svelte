<script lang="ts">
	import Bot from '@lucide/svelte/icons/bot';
	import MenuValueLabel from '$lib/components/shared/MenuValueLabel.svelte';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages.js';

	let {
		summary,
		disabled,
		onSelect,
	}: { summary: string; disabled?: boolean; onSelect: () => void } = $props();
</script>

<DropdownMenuItem
	{onSelect}
	{disabled}
	textValue={m.chat_composer_model()}
	data-composer-control="model"
	class="group"
>
	<Bot class="size-4" />
	<MenuValueLabel label={m.chat_composer_model()} value={summary} wrapValue />
</DropdownMenuItem>
