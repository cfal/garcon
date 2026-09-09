<script lang="ts">
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Plus from '@lucide/svelte/icons/plus';
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import { Button } from '$lib/components/ui/button';

	let {
		kind,
		title,
		description,
		actionLabel,
		onAction,
	}: {
		kind: 'boards' | 'columns';
		title: string;
		description: string;
		actionLabel: string;
		onAction: () => void;
	} = $props();
</script>

<div class="grid min-h-0 flex-1 place-items-center p-6" data-chat-board-empty={kind}>
	<div class="max-w-sm text-center">
		<div
			class="mx-auto grid size-12 place-items-center rounded-2xl border border-chat-board-lane-border bg-chat-board-lane text-muted-foreground shadow-sm"
		>
			{#if kind === 'boards'}
				<LayoutDashboard class="size-5" aria-hidden="true" />
			{:else}
				<Columns3 class="size-5" aria-hidden="true" />
			{/if}
		</div>
		<h2 class="mt-4 text-base font-semibold tracking-tight text-foreground">{title}</h2>
		<p class="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>
		<Button
			class="mt-5 gap-2"
			onclick={onAction}
			data-chat-board-create={kind === 'boards' ? '' : undefined}
		>
			<Plus class="size-4" aria-hidden="true" />
			{actionLabel}
		</Button>
	</div>
</div>
