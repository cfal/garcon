<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { buttonVariants } from '$lib/components/ui/button';
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
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { getModelCatalog } from '$lib/context';
	import type { ApiProtocol, ApiProviderCatalogEntry } from '$shared/api-providers';
	import type { DeviceAuthInfo, AgentReadiness } from '$lib/api/agents';
	import { templatesForProtocol, type ApiProviderTemplateId } from '$shared/api-provider-templates';
	import ApiProviderEndpointDialog from './ApiProviderEndpointDialog.svelte';
	import AgentCard from './AgentCard.svelte';
	import { deleteApiProviderEndpoint } from './api-provider-endpoint-dialog-state.svelte';

	interface AuthStatus {
		authenticated: boolean;
		canReauth: boolean;
		label: string;
		loading: boolean;
		error: string | null;
	}

	interface OAuthAgentConfig {
		id: 'claude' | 'codex';
		name: string;
	}

	let {
		protocol,
		title,
		description,
		addLabel,
		oauthAgent = undefined,
		auth = undefined,
		readiness = undefined,
		deviceAuth = undefined,
		pending = false,
		onLogin = undefined,
		onCompleteLogin = undefined,
	}: {
		protocol: ApiProtocol;
		title: string;
		description: string;
		addLabel: string;
		oauthAgent?: OAuthAgentConfig;
		auth?: AuthStatus;
		readiness?: AgentReadiness;
		deviceAuth?: DeviceAuthInfo;
		pending?: boolean;
		onLogin?: () => void;
		onCompleteLogin?: (code: string) => void;
	} = $props();

	const modelCatalog = getModelCatalog();
	let dialogOpen = $state(false);
	let editingEndpointId = $state<string | null>(null);
	let createTemplateId = $state<ApiProviderTemplateId>('custom');
	let deleteEndpointId = $state<string | null>(null);
	let error = $state<string | null>(null);
	let oauthOpen = $state(false);
	const templateOptions = $derived(templatesForProtocol(protocol));

	const endpointRows = $derived.by(() => {
		const rows: Array<{
			apiProvider: ApiProviderCatalogEntry;
			endpoint: ApiProviderCatalogEntry['endpoints'][number];
		}> = [];
		for (const apiProvider of modelCatalog.apiProviderCatalog) {
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

	function beginCreate(templateId: ApiProviderTemplateId) {
		editingEndpointId = null;
		createTemplateId = templateId;
		error = null;
		dialogOpen = true;
	}

	function beginEdit(endpointId: string) {
		editingEndpointId = endpointId;
		error = null;
		dialogOpen = true;
	}

	async function confirmDelete() {
		if (!deleteEndpointId) return;
		error = null;
		try {
			await deleteApiProviderEndpoint(modelCatalog, deleteEndpointId);
			deleteEndpointId = null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
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
			<h2 class="text-base font-semibold text-foreground">{title}</h2>
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

	{#if error}
		<div
			class="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{error}
		</div>
	{/if}

	{#if oauthAgent && auth}
		<AgentCard
			agentId={oauthAgent.id}
			agentName={oauthAgent.name}
			{auth}
			open={oauthOpen}
			onOpenChange={(open) => {
				oauthOpen = open;
			}}
			onLogin={onLogin ?? (() => undefined)}
			onCompleteLogin={onCompleteLogin ?? (() => undefined)}
			{deviceAuth}
			{pending}
			{readiness}
		/>
	{/if}

	<div class="space-y-2">
		{#each endpointRows as row (row.endpoint.id)}
			<div class="rounded-lg border border-border bg-muted/40 px-4 py-3">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0 space-y-1">
						<div class="flex items-center gap-2">
							<div class="truncate text-sm font-medium text-foreground">
								{row.apiProvider.label}
							</div>
						</div>
						<div class="truncate text-xs text-muted-foreground">{row.endpoint.baseUrl}</div>
						<div class="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
							<span
								>{m.settings_api_providers_model_count({ count: row.endpoint.models.length })}</span
							>
							<span
								>{m.settings_api_providers_default_model({
									model: row.endpoint.defaultModel,
								})}</span
							>
							<span
								>{row.endpoint.hasApiKey
									? m.settings_api_providers_key_configured()
									: m.settings_api_providers_no_key()}</span
							>
						</div>
					</div>

					<div class="flex shrink-0 items-center gap-1">
						<Button variant="outline" size="sm" onclick={() => beginEdit(row.endpoint.id)}>
							<PencilIcon class="mr-1 size-3" />
							{m.settings_api_providers_edit()}
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							onclick={() => {
								deleteEndpointId = row.endpoint.id;
							}}
						>
							<TrashIcon class="size-4" />
						</Button>
					</div>
				</div>

				{#if deleteEndpointId === row.endpoint.id}
					<div
						class="mt-3 flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2"
					>
						<span class="text-sm text-destructive">{m.settings_api_providers_confirm_delete()}</span
						>
						<Button variant="destructive" size="sm" onclick={confirmDelete}
							>{m.settings_api_providers_delete()}</Button
						>
						<Button
							variant="outline"
							size="sm"
							onclick={() => {
								deleteEndpointId = null;
							}}>{m.settings_api_providers_cancel()}</Button
						>
					</div>
				{/if}
			</div>
		{/each}
	</div>

	{#if dialogOpen}
		<ApiProviderEndpointDialog
			open={dialogOpen}
			{protocol}
			endpointId={editingEndpointId}
			templateId={createTemplateId}
			onOpenChange={(open) => {
				dialogOpen = open;
			}}
		/>
	{/if}
</section>
