<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Network from '@lucide/svelte/icons/network';
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
				{endpoint.models.length} models · {endpoint.defaultModel}
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
				title="Edit shared profile"
				aria-label={`Edit ${profile.label}`}
				onclick={onEdit}><PencilIcon class="size-4" /></Button
			>
			<Button
				variant="ghost"
				size="icon-sm"
				title="Duplicate profile"
				aria-label={`Duplicate ${profile.label}`}
				onclick={onDuplicate}><CopyIcon class="size-4" /></Button
			>
			<Button
				variant="ghost"
				size="icon-sm"
				title="Delete shared profile"
				aria-label={`Delete ${profile.label}`}
				onclick={() => (confirmingDelete = true)}><TrashIcon class="size-4" /></Button
			>
		</div>
	</div>
	<div class="mt-3 flex min-w-0 flex-wrap gap-1.5">
		{#each assignedExecutors as executor (executor.id)}
			<span
				class="flex w-fit min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
				data-slot="api-provider-executor"
				title={`Executor: ${executor.label}`}
			>
				<Network class="size-3 shrink-0 text-file-icon-folder" aria-hidden="true" />
				<span class="sr-only">Executor: {executor.label}</span>
				<span class="truncate" aria-hidden="true">{executor.label}</span>
			</span>
		{:else}
			<span class="text-xs text-muted-foreground">No executors assigned</span>
		{/each}
	</div>
	{#if confirmingDelete}
		<div class="mt-3 space-y-2 text-sm">
			<p class="text-destructive">
				Delete this shared profile from all workspaces? Selections in other workspaces may stop
				working.
			</p>
			<div class="flex gap-2">
				<Button
					variant="destructive"
					size="sm"
					disabled={providers.mutating}
					onclick={() => providers.deleteProfile(profile.id)}>Delete shared profile</Button
				>
				<Button variant="outline" size="sm" onclick={() => (confirmingDelete = false)}
					>Cancel</Button
				>
			</div>
		</div>
	{/if}
</div>
