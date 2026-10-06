<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import ExecutorPill from '$lib/components/shared/ExecutorPill.svelte';
	import { getApiProviders, getExecutors } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type {
		ApiProviderCatalogEntry,
		ApiProviderEndpointCatalogEntry,
	} from '$shared/api-providers';

	let {
		profile,
		endpoint,
		onEdit,
		onDuplicate,
	}: {
		profile: ApiProviderCatalogEntry;
		endpoint: ApiProviderEndpointCatalogEntry;
		onEdit: () => void;
		onDuplicate: () => void;
	} = $props();
	const providers = getApiProviders();
	const executors = getExecutors();
	let confirmingDelete = $state(false);
	const assignedExecutors = $derived(
		providers.executorIdsFor(profile.id).map((id) => ({
			id,
			label: executors.get(id)?.label ?? id,
		})),
	);
</script>

<div data-api-provider-id={profile.id} class="rounded-lg border border-border px-4 py-3">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 space-y-1">
			<h3 class="break-words text-sm font-medium text-foreground">{profile.label}</h3>
			<div class="break-all text-xs text-muted-foreground">{endpoint.baseUrl}</div>
			<div class="break-words text-xs text-muted-foreground">
				{m.settings_provider_model_summary({ count: endpoint.models.length, defaultModel: endpoint.defaultModel })}
			</div>
			<div class="text-xs text-muted-foreground">
				{endpoint.hasApiKey
					? m.settings_api_providers_key_configured()
					: m.settings_api_providers_no_key()}
			</div>
		</div>
		<div class="flex shrink-0 gap-1">
			<Button
				variant="ghost"
				size="icon-sm"
				title={m.settings_provider_edit_shared()}
				aria-label={m.settings_provider_edit_named({ label: profile.label })}
				onclick={onEdit}><PencilIcon class="size-4" /></Button
			>
			<Button
				variant="ghost"
				size="icon-sm"
				title={m.settings_provider_duplicate()}
				aria-label={m.settings_provider_duplicate_named({ label: profile.label })}
				onclick={onDuplicate}><CopyIcon class="size-4" /></Button
			>
			<Button
				variant="ghost"
				size="icon-sm"
				title={m.settings_provider_delete_shared()}
				aria-label={m.settings_provider_delete_named({ label: profile.label })}
				onclick={() => (confirmingDelete = true)}><TrashIcon class="size-4" /></Button
			>
		</div>
	</div>
	<div class="mt-3 flex min-w-0 flex-wrap gap-1.5">
		{#each assignedExecutors as executor (executor.id)}
			<ExecutorPill label={executor.label} data-slot="api-provider-executor" />
		{:else}
			<span class="text-xs text-muted-foreground">{m.settings_provider_unassigned()}</span>
		{/each}
	</div>
	{#if confirmingDelete}
		<div class="mt-3 space-y-2 text-sm">
			<p class="text-destructive">
				{m.settings_provider_delete_warning()}
			</p>
			<div class="flex gap-2">
				<Button
					variant="destructive"
					size="sm"
					disabled={providers.mutating}
					onclick={() => providers.deleteProfile(profile.id)}>{m.settings_provider_delete_shared()}</Button
				>
				<Button variant="outline" size="sm" onclick={() => (confirmingDelete = false)}
					>{m.common_cancel()}</Button
				>
			</div>
		</div>
	{/if}
</div>
