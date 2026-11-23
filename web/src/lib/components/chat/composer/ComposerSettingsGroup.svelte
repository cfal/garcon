<script lang="ts">
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import type { ModelTriggerWidths } from '$lib/agents/model-trigger-fit';
	import ModelSelectorMenuItem from '$lib/components/model-selector/ModelSelectorMenuItem.svelte';
	import type {
		ComposerSettingId,
		fitComposerToolbar,
	} from '$lib/chat/composer/composer-toolbar-layout';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import AgentSettingControl from './AgentSettingControl.svelte';
	import ComposerModeControl from './ComposerModeControl.svelte';
	import type { ComposerControlPlacement, ComposerToolbarSettings } from './composer-toolbar-types';
	import { OverflowMenuState } from '$lib/components/shared/overflow-menu-state.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		ids,
		layout,
		executor,
		model,
		onModelMeasure,
		agentSettings,
		permission,
		effort,
		bypass,
		disabled,
		align,
		side,
	}: ComposerToolbarSettings & {
		ids: readonly ComposerSettingId[];
		layout: ReturnType<typeof fitComposerToolbar>;
		onModelMeasure: (widths: ModelTriggerWidths) => void;
		bypass: boolean;
		disabled: boolean;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
	} = $props();
	let menuTrigger = $state<HTMLElement | null>(null);
	let picker = $state<ComposerModelSelector>();
	const menu = new OverflowMenuState(() => picker?.dismissPicker());
	export const closeOverflow = menu.closeThen;
	const folded = $derived(ids.filter((id) => !layout.inline.has(id)));
	const hiddenBypass = $derived(
		bypass && folded.includes('permission')
			? permission.options.find(({ value }) => value === permission.selected)
			: undefined,
	);
	const menuLabel = $derived(
		[m.chat_composer_more_settings(), hiddenBypass?.label].filter(Boolean).join(': '),
	);

	$effect.pre(() => {
		if (!folded.length) menu.open = false;
	});
</script>

{#snippet control(id: ComposerSettingId, placement: ComposerControlPlacement)}
	{#if id === 'executor' && executor}
		<ExecutorSelector
			{...executor}
			{disabled}
			service="agents"
			presentation={placement === 'menu' ? 'composer-menu' : 'composer'}
			hidden={placement === 'hidden'}
			compact={!layout.fullExecutor}
			{align}
			{side}
		/>
	{:else if id === 'effort'}
		<ComposerModeControl
			{id}
			label={m.chat_composer_thinking_effort()}
			{...effort}
			{placement}
			{align}
			{side}
			{disabled}
		/>
	{:else if id === 'permission'}
		<ComposerModeControl
			{id}
			label={m.chat_composer_permission_mode()}
			{...permission}
			{placement}
			{align}
			{side}
			{disabled}
		/>
	{:else if id === 'model' && model}
		{#if placement === 'menu'}
			<ModelSelectorMenuItem
				onSelect={() => closeOverflow(() => picker?.openPicker())}
				disabled={model.disabled || disabled}
				summary={picker?.selectionSummary() ?? ''}
			/>
		{:else}
			<ComposerModelSelector
				bind:this={picker}
				{...model}
				{align}
				{side}
				toolbarDisplay={layout.modelDisplay}
				onMeasure={onModelMeasure}
				overflowAnchor={placement === 'hidden' ? menuTrigger : null}
			/>
		{/if}
	{:else if agentSettings}
		{@const descriptor = agentSettings.descriptors.find((item) => `agent:${item.key}` === id)}
		{#if descriptor}
			<svelte:boundary>
				<AgentSettingControl settings={agentSettings} {descriptor} {placement} {align} {side} />
				{#snippet failed()}{/snippet}
			</svelte:boundary>
		{/if}
	{/if}
{/snippet}

<!-- Hidden triggers remain valid focus anchors for an enclosing dialog during resize. -->
{#each ids as id (id)}
	{@render control(id, layout.inline.has(id) ? 'inline' : 'hidden')}
{/each}
<DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
	<DropdownMenuTrigger
		bind:ref={menuTrigger}
		hidden={!folded.length}
		data-composer-overflow={folded.length ? 'settings' : undefined}
		title={menuLabel}
		aria-label={menuLabel}
		class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border focus-visible:ring-2 focus-visible:ring-ring {hiddenBypass?.toneClass ??
			'border-border bg-background hover:bg-muted'}"
	>
		{#if hiddenBypass}<ShieldAlert class="size-4" />{:else}<Ellipsis class="size-4" />{/if}
	</DropdownMenuTrigger>
	<DropdownMenuContent
		{align}
		{side}
		sideOffset={8}
		collisionPadding={8}
		class="w-64 max-w-[calc(100vw-1rem)]"
		getFocusReturnTarget={() => menuTrigger}
		onCloseAutoFocus={menu.onCloseAutoFocus}
	>
		{#each folded as id (id)}{@render control(id, 'menu')}{/each}
	</DropdownMenuContent>
</DropdownMenu>
