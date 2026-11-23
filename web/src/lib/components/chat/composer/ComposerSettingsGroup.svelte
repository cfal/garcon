<script lang="ts">
	import { tick, type ComponentProps } from 'svelte';
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
	import type { ComposerAgentSettings, ComposerExecutor } from './composer-toolbar-types';
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
	let openingModel = false;
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

	async function openModel() {
		openingModel = true;
		menuOpen = false;
		await tick();
		picker?.openPicker();
	}
</script>

{#snippet control(id: ComposerSettingId, overflow: boolean)}
	{#if id === 'executor' && executor}
		<ExecutorSelector
			{...executor}
			{disabled}
			service="agents"
			presentation={overflow ? 'composer-menu' : 'composer'}
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
			{overflow}
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
			{overflow}
			{align}
			{side}
			{disabled}
		/>
	{:else if id === 'model' && overflow}
		<DropdownMenuItem
			onSelect={() => void openModel()}
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
				<AgentSettingControl settings={agentSettings} {descriptor} {overflow} {align} {side} />
				{#snippet failed()}{/snippet}
			</svelte:boundary>
		{/if}
	{/if}
{/snippet}

{#each ids as id (id)}
	{#if id === 'model' && model}
		<div
			hidden={!layout.inline.has(id)}
			class="min-w-0"
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
	{:else if layout.inline.has(id)}
		{@render control(id, false)}
	{/if}
{/each}
{#if folded.length}
	<DropdownMenu
		bind:open={menuOpen}
		onOpenChange={(open) => {
			if (open) openingModel = false;
		}}
	>
		<DropdownMenuTrigger
			bind:ref={menuTrigger}
			data-composer-overflow="settings"
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
			onCloseAutoFocus={(event) => {
				if (openingModel) event.preventDefault();
			}}
		>
			{#each folded as id (id)}{@render control(id, true)}{/each}
		</DropdownMenuContent>
	</DropdownMenu>
{/if}
