<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import type { MenuPrimitives } from '$lib/components/ui/menu-primitives.js';

	let {
		menu,
		label,
		value,
		displayValue = value,
	}: {
		menu: MenuPrimitives;
		label: string;
		value: string;
		displayValue?: string;
	} = $props();
</script>

<menu.Item
	class="group items-start"
	textValue={label}
	aria-label={`${label}: ${value}`}
	data-workspace-copy-item
	onSelect={() => void copyToClipboard(value)}
>
	<Copy class="mt-0.5 size-4" />
	<div class="min-w-0 flex-1">
		<div class="font-medium">{label}</div>
		<div
			class="truncate text-xs text-muted-foreground group-data-[highlighted]:text-accent-foreground"
			title={value}
		>
			{displayValue}
		</div>
	</div>
</menu.Item>
