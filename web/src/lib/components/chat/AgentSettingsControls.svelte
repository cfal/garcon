<script lang="ts">
	import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
	import type { JsonValue } from '$shared/json';
	import { settingValue } from '$lib/agents/agent-settings.js';
	import { agentSettingLabel, agentSettingOptionLabel } from '$lib/agents/agent-setting-labels.js';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import BrainCircuit from '@lucide/svelte/icons/brain-circuit';

	interface Props {
		descriptors: readonly AgentSettingDescriptor[];
		envelope: AgentSettingsEnvelope;
		onChange: (descriptor: AgentSettingDescriptor, value: JsonValue) => void;
		disabled?: boolean;
	}

	let { descriptors, envelope, onChange, disabled = false }: Props = $props();

	function controlId(descriptor: AgentSettingDescriptor): string {
		return `agent-setting-${envelope.ownerId}-${descriptor.key}`.replace(/[^a-zA-Z0-9_-]/g, '-');
	}

	function numberValue(descriptor: Extract<AgentSettingDescriptor, { type: 'number' }>): number {
		const value = settingValue(envelope, descriptor);
		return typeof value === 'number' ? value : descriptor.min;
	}

	function stringValue(descriptor: AgentSettingDescriptor): string {
		const value = settingValue(envelope, descriptor);
		return typeof value === 'string' ? value : '';
	}

	function activeOptionLabel(
		descriptor: Extract<AgentSettingDescriptor, { type: 'enum' }>,
	): string {
		const value = stringValue(descriptor);
		const option = descriptor.options.find((candidate) => candidate.value === value);
		return option ? agentSettingOptionLabel(option) : value;
	}
</script>

{#if descriptors.length > 0}
	<div class="flex flex-wrap items-center gap-2" data-slot="agent-settings-controls">
		{#each descriptors as descriptor (descriptor.key)}
			<svelte:boundary>
				{#if descriptor.type === 'boolean'}
					<label
						for={controlId(descriptor)}
						class="inline-flex h-9 items-center gap-2 text-sm text-foreground"
					>
						<input
							id={controlId(descriptor)}
							type="checkbox"
							checked={settingValue(envelope, descriptor) === true}
							{disabled}
							class="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
							onchange={(event) => onChange(descriptor, event.currentTarget.checked)}
						/>
						<span>{descriptor.label}</span>
					</label>
				{:else if descriptor.type === 'enum'}
					<DropdownMenu>
						<DropdownMenuTrigger
							id={controlId(descriptor)}
							{disabled}
							data-slot="agent-setting-menu-trigger"
							aria-label={`${agentSettingLabel(descriptor)}: ${activeOptionLabel(descriptor)}`}
							title={`${agentSettingLabel(descriptor)}: ${activeOptionLabel(descriptor)}`}
							class="inline-flex size-9 items-center justify-center rounded-lg border border-composer-agent-setting-border bg-composer-agent-setting text-composer-agent-setting-foreground outline-none transition-colors hover:bg-composer-agent-setting/80 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							<BrainCircuit class="size-4" aria-hidden="true" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuRadioGroup
								value={stringValue(descriptor)}
								onValueChange={(value) => onChange(descriptor, value)}
							>
								{#each descriptor.options as option (option.value)}
									<DropdownMenuRadioItem value={option.value}>
										{agentSettingOptionLabel(option)}
									</DropdownMenuRadioItem>
								{/each}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				{:else if descriptor.type === 'number'}
					<label
						for={controlId(descriptor)}
						class="grid min-w-28 gap-1 text-xs text-muted-foreground"
					>
						<span>{descriptor.label}</span>
						<input
							id={controlId(descriptor)}
							type="number"
							value={numberValue(descriptor)}
							min={descriptor.min}
							max={descriptor.max}
							step={descriptor.step}
							{disabled}
							class="h-9 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
							onchange={(event) => onChange(descriptor, event.currentTarget.valueAsNumber)}
						/>
					</label>
				{:else}
					<label
						for={controlId(descriptor)}
						class="grid min-w-40 gap-1 text-xs text-muted-foreground"
					>
						<span>{descriptor.label}</span>
						<input
							id={controlId(descriptor)}
							type="text"
							value={stringValue(descriptor)}
							{disabled}
							class="h-9 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
							onchange={(event) => onChange(descriptor, event.currentTarget.value)}
						/>
					</label>
				{/if}
			</svelte:boundary>
		{/each}
	</div>
{/if}
