<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils/cn.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { onMount } from 'svelte';
	import { getApiProviders } from '$lib/context';
	import type { ApiProtocol, ApiProviderCatalogEntry } from '$shared/api-providers';
	import { templatesForProtocol, type ApiProviderTemplateId } from '$shared/api-provider-templates';
	import ApiProviderEndpointDialog from './ApiProviderEndpointDialog.svelte';
	import ApiProviderProfileRow from './ApiProviderProfileRow.svelte';

	type ProviderDialogRequest =
		| { kind: 'create'; templateId: ApiProviderTemplateId }
		| { kind: 'edit' | 'duplicate'; endpointId: string };

	let {
		protocol,
		title,
		description,
		addLabel,
	}: {
		protocol: ApiProtocol;
		title: string;
		description: string;
		addLabel: string;
	} = $props();

	const providers = getApiProviders();
	onMount(() => providers.retain());
	let dialogRequest = $state<ProviderDialogRequest | null>(null);
	const templateOptions = $derived(templatesForProtocol(protocol));

	const endpointRows = $derived.by(() => {
		const rows: Array<{
			apiProvider: ApiProviderCatalogEntry;
			endpoint: ApiProviderCatalogEntry['endpoints'][number];
		}> = [];
		for (const apiProvider of providers.providers) {
			for (const endpoint of apiProvider.endpoints) {
				if (endpoint.protocol === protocol) rows.push({ apiProvider, endpoint });
			}
		}
		return rows.sort(
			(a, b) =>
				a.apiProvider.label.localeCompare(b.apiProvider.label, undefined, {
					sensitivity: 'base',
				}) ||
				a.endpoint.baseUrl.localeCompare(b.endpoint.baseUrl, undefined, { sensitivity: 'base' }),
		);
	});

	function beginCreate(templateId: ApiProviderTemplateId): void {
		dialogRequest = { kind: 'create', templateId };
	}

	function beginEdit(endpointId: string): void {
		dialogRequest = { kind: 'edit', endpointId };
	}

	function beginDuplicate(endpointId: string): void {
		dialogRequest = { kind: 'duplicate', endpointId };
	}

	function templateMenuLabel(templateId: ApiProviderTemplateId): string {
		if (templateId === 'alibaba-cloud') return m.settings_api_providers_add_alibaba_cloud();
		if (templateId === 'fireworks') return m.settings_api_providers_add_fireworks();
		if (templateId === 'gemini') return m.settings_api_providers_add_gemini();
		if (templateId === 'openrouter') return m.settings_api_providers_add_openrouter();
		if (templateId === 'together') return m.settings_api_providers_add_together();
		if (templateId === 'zai') return m.settings_api_providers_add_zai();
		if (templateId === 'ollama') return m.settings_api_providers_add_ollama();
		return m.settings_api_providers_add_custom_provider();
	}
</script>

<section class="space-y-3">
	<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		<div class="space-y-1">
			<h3 class="text-sm font-semibold text-foreground">{title}</h3>
			<p class="text-sm text-muted-foreground">{description}</p>
			<div class="text-xs text-muted-foreground">
				{m.settings_api_providers_endpoint_count({ count: endpointRows.length })}
			</div>
		</div>
		<DropdownMenu>
			<DropdownMenuTrigger
				class={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
				aria-label={addLabel}
				title={addLabel}
			>
				<PlusIcon class="mr-2 size-4" />
				{m.settings_api_providers_add_provider()}
				<ChevronDownIcon class="ml-1 size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{#each templateOptions as template (`${template.protocol}:${template.id}`)}
					<DropdownMenuItem onclick={() => beginCreate(template.id)}>
						{templateMenuLabel(template.id)}
					</DropdownMenuItem>
				{/each}
			</DropdownMenuContent>
		</DropdownMenu>
	</div>

	<p class="text-xs text-muted-foreground">
		Assigned executors can receive this profile's credentials. Removing access does not revoke keys
		already received.
	</p>
	{#if providers.error}
		<div
			class="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{providers.error}
			<Button variant="outline" size="sm" onclick={() => providers.refresh()}>Retry</Button>
		</div>
	{/if}

	<div class="space-y-2">
		{#each endpointRows as row (row.endpoint.id)}
			<svelte:boundary>
				<ApiProviderProfileRow
					profile={row.apiProvider}
					endpoint={row.endpoint}
					onEdit={() => beginEdit(row.endpoint.id)}
					onDuplicate={() => beginDuplicate(row.endpoint.id)}
				/>
				{#snippet failed()}<p class="text-sm text-destructive">
						Unable to display provider.
					</p>{/snippet}
			</svelte:boundary>
		{/each}
	</div>

	{#if dialogRequest}
		<ApiProviderEndpointDialog
			open
			{protocol}
			duplicate={dialogRequest.kind === 'duplicate'}
			endpointId={dialogRequest.kind === 'create' ? null : dialogRequest.endpointId}
			templateId={dialogRequest.kind === 'create' ? dialogRequest.templateId : 'custom'}
			onOpenChange={(open) => {
				if (!open) dialogRequest = null;
			}}
		/>
	{/if}
</section>
