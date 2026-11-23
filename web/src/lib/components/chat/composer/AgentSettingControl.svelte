<script lang="ts">
	import type { AgentSettingDescriptor } from '$shared/agent-integration';
	import { settingValue } from '$shared/agent-settings';
	import {
		agentSettingLabel,
		agentSettingOptionDescription,
		agentSettingOptionLabel,
	} from '$lib/agents/agent-setting-labels.js';
	import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '$lib/components/ui/dropdown-menu';
	import Gauge from '@lucide/svelte/icons/gauge';
	import BrainCircuit from '@lucide/svelte/icons/brain-circuit';
	import AgentThinkingIcon from './AgentThinkingIcon.svelte';
	import ComposerSettingMenu from './ComposerSettingMenu.svelte';
	import type { ComposerAgentSettings } from './composer-toolbar-types';
	import * as m from '$lib/paraglide/messages.js';

	let {
		descriptor,
		settings,
		overflow,
		align,
		side,
	}: {
		descriptor: AgentSettingDescriptor;
		settings: ComposerAgentSettings;
		overflow: boolean;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
	} = $props();
	const value = $derived(
		settingValue(settings.envelope, descriptor) ?? settingValue(settings.defaults, descriptor),
	);
	const options = $derived(descriptor.type === 'enum' ? descriptor.options : []);
	const selected = $derived(options.find((option) => option.value === value));
	const label = $derived(agentSettingLabel(descriptor));
	const summary = $derived(
		selected
			? agentSettingOptionLabel(selected)
			: descriptor.type === 'boolean'
				? value
					? m.chat_composer_agent_setting_enabled()
					: m.chat_composer_agent_setting_disabled()
				: String(value ?? ''),
	);
	const inputId = $props.id();
</script>

<ComposerSettingMenu
	id={`agent:${descriptor.key}`}
	{label}
	value={summary}
	{overflow}
	{align}
	{side}
	disabled={settings.disabled}
	triggerSlot="agent-setting-menu-trigger"
	tone="border-composer-agent-setting-border bg-composer-agent-setting text-composer-agent-setting-foreground hover:bg-composer-agent-setting/80"
>
	{#snippet icon()}
		{#if descriptor.labelKey === 'thinking'}<AgentThinkingIcon />
		{:else if descriptor.labelKey === 'speed'}<Gauge class="size-4" />
		{:else}<BrainCircuit class="size-4" />{/if}
	{/snippet}
	{#if descriptor.type === 'enum'}
		<DropdownMenuRadioGroup
			value={typeof value === 'string' ? value : ''}
			onValueChange={(next) => settings.onChange(descriptor, next)}
		>
			{#each options as option (option.value)}
				{@const description = agentSettingOptionDescription(option)}
				<DropdownMenuRadioItem value={option.value} class="items-start">
					<div class="min-w-0">
						<div class="font-medium">{agentSettingOptionLabel(option)}</div>
						{#if description}<div data-menu-description class="text-xs text-muted-foreground">
								{description}
							</div>{/if}
					</div>
				</DropdownMenuRadioItem>
			{/each}
		</DropdownMenuRadioGroup>
	{:else if descriptor.type === 'boolean'}
		<DropdownMenuRadioGroup
			value={String(value === true)}
			onValueChange={(next) => settings.onChange(descriptor, next === 'true')}
		>
			<DropdownMenuRadioItem value="true"
				>{m.chat_composer_agent_setting_enabled()}</DropdownMenuRadioItem
			>
			<DropdownMenuRadioItem value="false"
				>{m.chat_composer_agent_setting_disabled()}</DropdownMenuRadioItem
			>
		</DropdownMenuRadioGroup>
	{:else}
		<label for={inputId} class="grid gap-1 p-2 text-sm"
			>{label}
			{#if descriptor.type === 'number'}
				<input
					id={inputId}
					type="number"
					min={descriptor.min}
					max={descriptor.max}
					step={descriptor.step}
					value={typeof value === 'number' ? value : descriptor.min}
					class="h-9 rounded border border-input bg-background px-2 text-base"
					onchange={(event) => {
						if (
							event.currentTarget.validity.valid &&
							Number.isFinite(event.currentTarget.valueAsNumber)
						)
							settings.onChange(descriptor, event.currentTarget.valueAsNumber);
					}}
				/>
			{:else}
				<input
					id={inputId}
					type="text"
					value={summary}
					class="h-9 rounded border border-input bg-background px-2 text-base"
					onchange={(event) => settings.onChange(descriptor, event.currentTarget.value)}
				/>
			{/if}
		</label>
	{/if}
</ComposerSettingMenu>
