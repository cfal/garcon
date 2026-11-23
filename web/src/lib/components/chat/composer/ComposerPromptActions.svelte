<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { ComposerControlId } from '$lib/chat/composer/composer-toolbar-layout';
	import type { ComposerPromptAction } from './composer-prompt-actions';
	import { handOffComposerMenuFocus } from './composer-toolbar-focus';
	import MenuValueLabel from '$lib/components/shared/MenuValueLabel.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		actions,
		inline,
		align,
		side,
	}: {
		actions: readonly ComposerPromptAction[];
		inline: ReadonlySet<ComposerControlId>;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
	} = $props();
	const folded = $derived(actions.filter((action) => !inline.has(action.id)));
	const label = $derived(
		folded.some(({ id }) => id === 'expand' || id === 'refine')
			? m.chat_composer_more_actions()
			: m.snippets_add_to_prompt(),
	);
	const button =
		'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
	const ordinary = 'border-border bg-background text-foreground hover:bg-muted';
	let handoff: (() => void) | undefined;
	let menuOpen = $state(false);

	$effect.pre(() => {
		if (!folded.length) menuOpen = false;
	});

	export function closeOverflow(afterClose: () => void): void {
		handoff = afterClose;
		menuOpen = false;
	}

	function activate(action: ComposerPromptAction): void {
		if (action.disabled) return;
		if (action.id === 'image') action.run();
		else closeOverflow(action.run);
	}
</script>

<DropdownMenu
	bind:open={menuOpen}
	onOpenChange={(open) => {
		if (open) handoff = undefined;
	}}
>
	<DropdownMenuTrigger
		hidden={!folded.length}
		disabled={folded.every((action) => action.disabled)}
		aria-label={label}
		title={label}
		data-composer-overflow={folded.length ? 'prompt' : undefined}
		class="{button} {ordinary}"><Plus class="size-4" /></DropdownMenuTrigger
	>
	<DropdownMenuContent
		{align}
		{side}
		sideOffset={8}
		collisionPadding={8}
		class="w-64 max-w-[calc(100vw-1rem)]"
		onCloseAutoFocus={(event) => handOffComposerMenuFocus(event, handoff)}
	>
		{#each folded as action (action.id)}
			<DropdownMenuItem
				disabled={action.disabled}
				textValue={action.label}
				onSelect={() => activate(action)}
				class="group items-start"
				data-composer-control={action.id}
			>
				<action.icon class="mt-0.5 size-4" />
				{#if action.description}<MenuValueLabel label={action.label} value={action.description} />
				{:else}{action.label}{/if}
			</DropdownMenuItem>
		{/each}
	</DropdownMenuContent>
</DropdownMenu>
{#each actions as action (action.id)}
	<button
		type="button"
		hidden={!inline.has(action.id)}
		disabled={action.disabled}
		onclick={action.run}
		aria-label={action.label}
		title={action.disabled && action.description ? action.description : action.label}
		data-composer-control={action.id}
		class="{button} {action.active ? 'border-accent bg-accent text-accent-foreground' : ordinary}"
	>
		<action.icon class="size-4" />
	</button>
{/each}
