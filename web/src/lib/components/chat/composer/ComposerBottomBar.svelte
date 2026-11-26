<script lang="ts">
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Send from '@lucide/svelte/icons/send';
	import type { ModelTriggerWidths } from '$lib/agents/model-trigger-fit';
	import {
		fitComposerToolbar,
		type ComposerSettingId,
	} from '$lib/chat/composer/composer-toolbar-layout';
	import ComposerPromptActions from './ComposerPromptActions.svelte';
	import ComposerSettingsGroup from './ComposerSettingsGroup.svelte';
	import { composerPromptActions, type PromptActionOptions } from './composer-prompt-actions';
	import type { ComposerToolbarSettings } from './composer-toolbar-types';
	import { retainComposerToolbarFocus } from './composer-toolbar-focus';
	import * as m from '$lib/paraglide/messages.js';

	interface Props extends PromptActionOptions, ComposerToolbarSettings {
		send?: { enabled: boolean; title: string; onSend: () => void };
		modelControlsLeft?: boolean;
		side?: 'top' | 'bottom';
		settingsDisabled?: boolean;
		promptTransformStatus?: string;
	}
	let {
		permission,
		effort,
		executor,
		agentSettings,
		model,
		send,
		modelControlsLeft = true,
		side = 'top',
		settingsDisabled = false,
		promptTransformStatus = m.snippets_expanding(),
		...prompt
	}: Props = $props();
	let row = $state<HTMLDivElement>();
	let promptGroup = $state<ComposerPromptActions>();
	let settingsGroup = $state<ComposerSettingsGroup>();
	let ruler = $state<HTMLElement>();
	let rowRect = $state.raw<DOMRectReadOnly>();
	let measuredRem = $state<number>();
	const rowWidth = $derived(rowRect?.width ?? row?.clientWidth ?? 0);
	const rem = $derived(measuredRem ?? (ruler?.clientWidth || 16));
	let modelWidths = $state<ModelTriggerWidths>();
	let executorWidth = $state<number>();

	function measureRem({ width }: DOMRectReadOnly): void {
		if (width) measuredRem = width;
	}
	const { actions, explainUnavailableImage } = $derived(composerPromptActions(prompt));
	const settings = $derived.by(() => {
		const ids: ComposerSettingId[] = [];
		if (executor?.executors.showComposerExecutor(executor.executorId)) ids.push('executor');
		if (model) ids.push('model');
		if (effort.options.length > 1) ids.push('effort');
		for (const descriptor of agentSettings?.descriptors ?? []) ids.push(`agent:${descriptor.key}`);
		if (permission.options.length > 1) ids.push('permission');
		return ids;
	});
	const bypass = $derived(
		permission.selected === 'bypassPermissions' || permission.selected === 'manualBypass',
	);
	const layout = $derived(
		fitComposerToolbar(
			{
				prompt: actions.map(({ id }) => id),
				settings,
				send: Boolean(send),
				refining: Boolean(prompt.isPromptRefinementPending),
				bypass,
				explainUnavailableImage,
			},
			rowWidth / rem,
			modelWidths
				? { combined: modelWidths.combined / rem, model: modelWidths.model / rem }
				: undefined,
			executorWidth === undefined ? undefined : executorWidth / rem,
		),
	);
	const groups = $derived(modelControlsLeft ? ['settings', 'prompt'] : ['prompt', 'settings']);
	$effect.pre(() => {
		const placement = layout;
		void groups;
		if (row)
			void retainComposerToolbarFocus(row, placement, (group, afterClose) => {
				(group === 'prompt' ? promptGroup : settingsGroup)?.closeOverflow(afterClose);
			});
	});
</script>

<div
	class="relative mt-1 w-full min-w-0 max-w-full px-2 py-1.5"
	style="container: composer-controls / inline-size"
	data-slot="composer-bottom-bar"
>
	<span
		aria-hidden="true"
		class="pointer-events-none invisible absolute w-4"
		bind:this={ruler}
		bind:contentRect={null, measureRem}
	></span>
	<div bind:this={row} bind:contentRect={rowRect} class="flex min-w-0 flex-nowrap items-center gap-1" data-composer-toolbar>
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
							{explainUnavailableImage}
							foldedIds={layout.foldedPrompt}
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
							onModelMeasure={(widths) => {
								modelWidths = widths;
							}}
							onExecutorMeasure={(width) => {
								executorWidth = width;
							}}
							{agentSettings}
							{permission}
							{effort}
							{bypass}
							align={first ? 'start' : 'end'}
							{side}
							disabled={settingsDisabled}
						/>
					{/if}
				</div>
			{/if}
		{/each}
		{#if send}
			{@const label = prompt.isPromptTransformPending ? promptTransformStatus : send.title}
			<button
				type="button"
				onclick={send.onSend}
				disabled={!send.enabled || prompt.isPromptTransformPending}
				class:ml-1={actions.length > 0 || settings.length > 0}
				class="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary text-primary-foreground ring-offset-background transition-colors outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground"
				title={label}
				aria-label={label}
			>
				{#if prompt.isPromptTransformPending}
					<Loader2 class="size-4 animate-spin" aria-hidden="true" />
				{:else}
					<Send class="size-4" aria-hidden="true" />
				{/if}
			</button>
		{/if}
	</div>
</div>
<span class="sr-only" aria-live="polite"
	>{prompt.isPromptTransformPending ? promptTransformStatus : ''}</span
>
