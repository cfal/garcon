<script lang="ts">
	import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
	import type { JsonValue } from '$shared/json';
	import { settingValue } from '$lib/agents/agent-settings.js';

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
</script>

{#if descriptors.length > 0}
	<div class="flex flex-wrap items-end gap-x-3 gap-y-2" data-slot="agent-settings-controls">
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
					<label
						for={controlId(descriptor)}
						class="grid min-w-32 gap-1 text-xs text-muted-foreground"
					>
						<span>{descriptor.label}</span>
						<select
							id={controlId(descriptor)}
							value={stringValue(descriptor)}
							{disabled}
							class="h-9 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
							onchange={(event) => onChange(descriptor, event.currentTarget.value)}
						>
							{#each descriptor.options as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</label>
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
