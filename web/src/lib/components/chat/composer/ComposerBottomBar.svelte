<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Send from '@lucide/svelte/icons/send';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import type { ComposerModeOption } from '$lib/chat/composer/composer-controls';
	import {
		fitComposerToolbar,
		type ComposerSettingId,
	} from '$lib/chat/composer/composer-toolbar-layout';
	import type ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import ComposerPromptActions from './ComposerPromptActions.svelte';
	import ComposerSettingsGroup from './ComposerSettingsGroup.svelte';
	import { composerPromptActions, type PromptActionOptions } from './composer-prompt-actions';
	import type { ComposerAgentSettings, ComposerExecutor } from './composer-toolbar-types';
	import { retainComposerToolbarFocus } from './composer-toolbar-focus';
	import * as m from '$lib/paraglide/messages.js';

	interface Props extends PromptActionOptions {
		permissionOptions: ComposerModeOption<PermissionMode>[];
		selectedPermission: PermissionMode;
		onPermissionSelect: (mode: PermissionMode) => void;
		thinkingOptions: ComposerModeOption<ThinkingMode>[];
		selectedThinking: ThinkingMode;
		onThinkingSelect: (mode: ThinkingMode) => void;
		executor?: ComposerExecutor;
		agentSettings?: ComposerAgentSettings;
		model?: ComponentProps<typeof ComposerModelSelector>;
		canSend: boolean;
		onSend: () => void;
		sendTitle: string;
		sendButtonClass: string;
		modelControlsLeft?: boolean;
		side?: 'top' | 'bottom';
		showSendButton?: boolean;
		settingsDisabled?: boolean;
		promptTransformStatus?: string;
	}
	let {
		permissionOptions,
		selectedPermission,
		onPermissionSelect,
		thinkingOptions,
		selectedThinking,
		onThinkingSelect,
		executor,
		agentSettings,
		model,
		canSend,
		onSend,
		sendTitle,
		sendButtonClass,
		modelControlsLeft = false,
		side = 'top',
		showSendButton = true,
		settingsDisabled = false,
		promptTransformStatus = m.snippets_expanding(),
		...prompt
	}: Props = $props();
	let row = $state<HTMLDivElement>();
	let promptGroup = $state<ComposerPromptActions>();
	let settingsGroup = $state<ComposerSettingsGroup>();
	let unit = $state<HTMLElement>();
	let widthRem = $state(0);
	$effect(() => {
		const toolbar = row,
			ruler = unit;
		if (!toolbar || !ruler) return;
		const measure = () => {
			widthRem = toolbar.clientWidth / (ruler.clientWidth || 16);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(toolbar);
		observer.observe(ruler);
		return () => observer.disconnect();
	});
	const actions = $derived(composerPromptActions(prompt));
	const settings = $derived.by(() => {
		const ids: ComposerSettingId[] = [];
		if (executor?.executors.showComposerExecutor(executor.executorId)) ids.push('executor');
		if (model) ids.push('model');
		if (thinkingOptions.length > 1) ids.push('effort');
		for (const descriptor of agentSettings?.descriptors ?? []) ids.push(`agent:${descriptor.key}`);
		if (permissionOptions.length > 1) ids.push('permission');
		return ids;
	});
	const layout = $derived(
		fitComposerToolbar(
			{
				prompt: actions.map(({ id }) => id),
				settings,
				send: showSendButton,
				refining: Boolean(prompt.isPromptRefinementPending),
				bypass: selectedPermission === 'bypassPermissions' || selectedPermission === 'manualBypass',
			},
			widthRem,
		),
	);
	const groups = $derived(modelControlsLeft ? ['settings', 'prompt'] : ['prompt', 'settings']);
	const sendLabel = $derived(prompt.isPromptTransformPending ? promptTransformStatus : sendTitle);
	$effect.pre(() => {
		const { inline } = layout;
		void groups;
		if (row)
			void retainComposerToolbarFocus(row, inline, (group, afterClose) => {
				(group === 'prompt' ? promptGroup : settingsGroup)?.closeOverflow(afterClose);
			});
	});
</script>

<div
	class="relative mt-1 w-full min-w-0 max-w-full px-2 py-1.5"
	style="container: composer-controls / inline-size"
	data-slot="composer-bottom-bar"
>
	<span aria-hidden="true" class="pointer-events-none invisible absolute w-4" bind:this={unit}
	></span>
	<div bind:this={row} class="flex min-w-0 flex-nowrap items-center gap-1" data-composer-toolbar>
		{#each groups as group (group)}
			{@const first = group === groups[0]}
			{#if group === 'settings' ? settings.length > 0 : actions.length > 0}
				<div
					data-composer-group={group}
					class="flex min-w-0 items-center gap-1 {first ? 'mr-auto' : 'ml-auto'}"
				>
					{#if group === 'prompt'}
						<ComposerPromptActions
							bind:this={promptGroup}
							{actions}
							inline={layout.inline}
							align={first ? 'start' : 'end'}
							{side}
						/>
					{:else}
						<ComposerSettingsGroup
							bind:this={settingsGroup}
							ids={settings}
							{layout}
							{executor}
							{model}
							{agentSettings}
							{permissionOptions}
							{selectedPermission}
							{onPermissionSelect}
							{thinkingOptions}
							{selectedThinking}
							{onThinkingSelect}
							align={first ? 'start' : 'end'}
							{side}
							disabled={settingsDisabled}
						/>
					{/if}
				</div>
			{/if}
		{/each}
		{#if showSendButton}
			<button
				type="button"
				onclick={onSend}
				disabled={!canSend || prompt.isPromptTransformPending}
				class:ml-1={actions.length > 0 || settings.length > 0}
				class="inline-flex size-9 shrink-0 items-center justify-center rounded-full border ring-offset-background transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground {sendButtonClass}"
				title={sendLabel}
				aria-label={sendLabel}
			>
				{#if prompt.isPromptTransformPending}<Loader2
						class="size-4 animate-spin"
						aria-hidden="true"
					/>{:else}<Send class="size-4" aria-hidden="true" />{/if}
			</button>
		{/if}
	</div>
</div>
<span class="sr-only" aria-live="polite"
	>{prompt.isPromptTransformPending ? promptTransformStatus : ''}</span
>
