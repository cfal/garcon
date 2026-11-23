<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Bot from '@lucide/svelte/icons/bot';
	import type {
		ComposerSettingId,
		fitComposerToolbar,
	} from '$lib/chat/composer/composer-toolbar-layout';
	import type { ComposerModeOption } from '$lib/chat/composer/composer-controls';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import MenuValueLabel from '$lib/components/shared/MenuValueLabel.svelte';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import AgentSettingControl from './AgentSettingControl.svelte';
	import ComposerModeControl from './ComposerModeControl.svelte';
	import type {
		ComposerAgentSettings,
		ComposerControlPlacement,
		ComposerExecutor,
	} from './composer-toolbar-types';
	import { handOffComposerMenuFocus } from './composer-toolbar-focus';
	import * as m from '$lib/paraglide/messages.js';

	let {
		ids,
		layout,
		executor,
		model,
		agentSettings,
		permissionOptions,
		selectedPermission,
		onPermissionSelect,
		thinkingOptions,
		selectedThinking,
		onThinkingSelect,
		disabled,
		align,
		side,
	}: {
		ids: readonly ComposerSettingId[];
		layout: ReturnType<typeof fitComposerToolbar>;
		executor?: ComposerExecutor;
		model?: ComponentProps<typeof ComposerModelSelector>;
		agentSettings?: ComposerAgentSettings;
		permissionOptions: ComposerModeOption<PermissionMode>[];
		selectedPermission: PermissionMode;
		onPermissionSelect: (mode: PermissionMode) => void;
		thinkingOptions: ComposerModeOption<ThinkingMode>[];
		selectedThinking: ThinkingMode;
		onThinkingSelect: (mode: ThinkingMode) => void;
		disabled: boolean;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
	} = $props();
	let menuTrigger = $state<HTMLElement | null>(null);
	let picker = $state<ComposerModelSelector>();
	let menuOpen = $state(false);
	let handoff: (() => void) | undefined;
	const folded = $derived(ids.filter((id) => !layout.inline.has(id)));
	const hiddenBypass = $derived(
		folded.includes('permission') &&
			(selectedPermission === 'manualBypass' || selectedPermission === 'bypassPermissions')
			? permissionOptions.find(({ value }) => value === selectedPermission)
			: undefined,
	);
	const menuLabel = $derived(
		[m.chat_composer_more_settings(), hiddenBypass?.label].filter(Boolean).join(': '),
	);

	$effect.pre(() => {
		if (!folded.length) menuOpen = false;
	});

	export function closeOverflow(afterClose: () => void): void {
		handoff = afterClose;
		menuOpen = false;
	}
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
			options={thinkingOptions}
			selected={selectedThinking}
			onSelect={onThinkingSelect}
			{placement}
			{align}
			{side}
			{disabled}
		/>
	{:else if id === 'permission'}
		<ComposerModeControl
			{id}
			label={m.chat_composer_permission_mode()}
			options={permissionOptions}
			selected={selectedPermission}
			onSelect={onPermissionSelect}
			{placement}
			{align}
			{side}
			{disabled}
		/>
	{:else if id === 'model' && placement === 'menu'}
		<DropdownMenuItem
			onSelect={() => closeOverflow(() => picker?.openPicker())}
			disabled={model?.disabled || disabled}
			textValue={m.chat_composer_model()}
			data-composer-control="model"
			class="group"
		>
			<Bot class="size-4" />
			<MenuValueLabel label={m.chat_composer_model()} value={picker?.selectionSummary() ?? ''} />
		</DropdownMenuItem>
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
	{#if id === 'model' && model}
		<div
			hidden={!layout.inline.has(id)}
			class="min-w-0"
			class:flex={layout.inline.has(id)}
			style:max-width="{layout.modelWidthRem}rem"
			data-composer-control="model"
		>
			<ComposerModelSelector
				bind:this={picker}
				{...model}
				{align}
				{side}
				triggerClass="max-w-full sm:max-w-full"
				overflowAnchor={layout.inline.has(id) ? null : menuTrigger}
			/>
		</div>
	{:else}
		{@render control(id, layout.inline.has(id) ? 'inline' : 'hidden')}
	{/if}
{/each}
<DropdownMenu
	bind:open={menuOpen}
	onOpenChange={(open) => {
		if (open) {
			handoff = undefined;
			picker?.dismissPicker();
		}
	}}
>
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
		onCloseAutoFocus={(event) => handOffComposerMenuFocus(event, handoff)}
	>
		{#each folded as id (id)}{@render control(id, 'menu')}{/each}
	</DropdownMenuContent>
</DropdownMenu>
