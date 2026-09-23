<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { getApiProviders, getExecutionNodes } from '$lib/context';
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
	const nodes = getExecutionNodes();
	let confirmingDelete = $state(false);

	function changeAssignment(input: HTMLInputElement, nodeId: string): void {
		const assigned = input.checked;
		// Keeps the DOM authoritative even when reconciliation returns the unchanged value.
		input.checked = providers.isAssigned(nodeId, profile.id);
		void providers.setAssignment(nodeId, profile.id, assigned);
	}
</script>

<div data-api-provider-id={profile.id} class="rounded-lg border border-border px-4 py-3">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 space-y-1">
			<h3 class="break-words text-sm font-medium text-foreground">{profile.label}</h3>
			<div class="break-all text-xs text-muted-foreground">{endpoint.baseUrl}</div>
			<div class="break-words text-xs text-muted-foreground">
				{endpoint.models.length} models · {endpoint.defaultModel}
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
	<fieldset class="mt-3" disabled={providers.mutating}>
		<legend class="mb-2 text-xs text-muted-foreground">Available on - this workspace</legend>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			{#each nodes.nodes as node (node.id)}
				<label class="flex min-w-0 items-center gap-2 text-sm">
					<input
						type="checkbox"
						class="size-4 shrink-0 accent-primary"
						checked={providers.isAssigned(node.id, profile.id)}
						onchange={(event) => changeAssignment(event.currentTarget, node.id)}
					/>
					<span class="break-words">{node.label}</span>
				</label>
			{/each}
		</div>
	</fieldset>
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
