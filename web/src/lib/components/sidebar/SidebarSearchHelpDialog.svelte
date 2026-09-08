<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';

	interface SidebarSearchHelpDialogProps {
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}

	let { open, onOpenChange }: SidebarSearchHelpDialogProps = $props();
</script>

<Dialog.Root {open} requestClose={() => onOpenChange(false)}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none overflow-y-auto rounded-none border-0 p-6 sm:max-w-none min-[769px]:pointer-fine:top-[50%] min-[769px]:pointer-fine:h-auto min-[769px]:pointer-fine:max-h-[calc(var(--app-height)-2rem)] min-[769px]:pointer-fine:w-[calc(100vw-2rem)] min-[769px]:pointer-fine:max-w-lg min-[769px]:pointer-fine:rounded-lg min-[769px]:pointer-fine:border"
	>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_search_legend_help()}</Dialog.Title>
			<p class="text-sm text-muted-foreground">
				{m.sidebar_search_legend_description()}
			</p>
		</Dialog.Header>
		<div class="space-y-2 text-sm">
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
					>Any text</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_free_text_description()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">title:X</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_title()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">tag:X</code>
				<span class="text-muted-foreground">{m.sidebar_search_legend_tag()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">agent:X</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_agent()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">model:X</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_model()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
					>status:X</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_status()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">is:X</code>
				<span class="text-muted-foreground">{m.sidebar_search_legend_order_group()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
					>project:X</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_project()}</span>
			</div>
			<div class="flex gap-3">
				<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
					>tag:X project:Y</code
				>
				<span class="text-muted-foreground">{m.sidebar_search_legend_combine()}</span>
			</div>
		</div>
		<Dialog.Footer>
			<Button onclick={() => onOpenChange(false)}>{m.editor_actions_close()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
