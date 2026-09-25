<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Switch } from '$lib/components/ui/switch';
	import * as Select from '$lib/components/ui/select';
	import { untrack } from 'svelte';
	import { getModelCatalog, getApiProviders, getExecutors } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { ApiProtocol } from '$shared/api-providers';
	import type { ApiProviderTemplateId } from '$shared/api-provider-templates';
	import { ApiProviderEndpointDialogState } from './api-provider-endpoint-dialog-state.svelte';

	let {
		open = false,
		protocol,
		endpointId = null,
		templateId = 'custom',
		duplicate = false,
		onOpenChange = () => undefined,
	} = $props<{
		open?: boolean;
		protocol: ApiProtocol;
		endpointId?: string | null;
		templateId?: ApiProviderTemplateId;
		duplicate?: boolean;
		onOpenChange?: (open: boolean) => void;
	}>();

	const rootModelCatalog = getModelCatalog();
	const providers = getApiProviders();
	const executors = getExecutors();
	let executorId = $state('local');
	const modelCatalog = $derived(rootModelCatalog.forExecutor(executorId));
	const dialog = new ApiProviderEndpointDialogState({
		get modelCatalog() {
			return modelCatalog;
		},
		providers,
		isExecutorReady: () => executors.isReady(executorId),
		getProtocol: () => protocol,
		getEndpointId: () => endpointId,
		getTemplateId: () => templateId,
		getDuplicate: () => duplicate,
		onSaved: () => onOpenChange(false),
	});

	$effect(() => {
		dialog.open = open;
		if (open) {
			untrack(() => {
				executorId = initialExecutorId();
				void dialog.load();
			});
		}
		return () => dialog.dispose();
	});

	function initialExecutorId(): string {
		const found = endpointId ? providers.findEndpoint(endpointId) : null;
		if (!found) return 'local';

		const assignedExecutors = executors.executors.filter((executor) => providers.isAssigned(executor.id, found.apiProvider.id));
		const readyExecutor = assignedExecutors.find((executor) => executors.isReady(executor.id));
		return readyExecutor?.id ?? assignedExecutors[0]?.id ?? 'local';
	}

	function selectExecutor(value: string): void {
		if (dialog.isSaving || value === executorId) return;
		dialog.clearProbeResults();
		executorId = value;
	}

	function handleModelsInput(event: Event) {
		const target = event.currentTarget as HTMLTextAreaElement;
		dialog.modelsText = target.value;
		dialog.syncDefaultModelWithModels();
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content
		class="flex h-dvh w-full max-w-full flex-col rounded-none border-0 p-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-3xl sm:rounded-lg sm:border"
	>
		<Dialog.Header class="border-b border-border px-6 py-4">
			<Dialog.Title>{dialog.title}</Dialog.Title>
			<Dialog.Description>{dialog.description}</Dialog.Description>
		</Dialog.Header>

		<form
			class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
			onsubmit={(event) => {
				event.preventDefault();
				void dialog.save();
			}}
		>
			{#if executors.hasRemoteExecutors}
				<div class="grid gap-2">
					<label class="text-sm font-medium" for="api-provider-executor">
						{dialog.apiProviderId
							? m.settings_provider_test_from()
							: m.settings_provider_create_on()}
					</label>
					<select
						id="api-provider-executor"
						class="h-9 min-w-0 w-full rounded-md border border-input bg-background px-3 text-base pointer-fine:text-sm"
						value={executorId}
						onchange={(event) => selectExecutor(event.currentTarget.value)}
						disabled={dialog.isSaving}
					>
						{#each executors.executors as executor (executor.id)}
							<option value={executor.id}>{executor.label}</option>
						{/each}
					</select>
				</div>
			{/if}
			{#if dialog.apiProviderId}
				<p class="text-sm text-muted-foreground">
					Changes affect every executor and workspace using this shared profile.
				</p>
			{/if}
			{#if !dialog.canProbe}
				<p class="text-sm text-muted-foreground">
					Testing requires a ready executor and an assigned profile or a newly entered key.
				</p>
			{/if}
			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-label"
					>{m.settings_api_provider_dialog_display_name()}</label
				>
				<Input id="api-provider-label" bind:value={dialog.label} />
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-base-url"
					>{m.settings_api_provider_dialog_base_url()}</label
				>
				<Input
					id="api-provider-base-url"
					bind:value={dialog.baseUrl}
					placeholder={dialog.baseUrlPlaceholder}
				/>
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-api-key"
					>{m.settings_api_provider_dialog_api_key()}</label
				>
				<Input
					id="api-provider-api-key"
					type="password"
					bind:value={dialog.apiKey}
					autocomplete="off"
					required={dialog.apiKeyRequired && !dialog.apiProviderId}
					placeholder={dialog.apiKeyPlaceholder}
				/>
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-default-model"
					>{m.settings_api_provider_dialog_default_model()}</label
				>
				<Select.Root
					type="single"
					value={dialog.defaultModel}
					onValueChange={(value) => {
						if (value) dialog.defaultModel = value;
					}}
				>
					<Select.Trigger
						id="api-provider-default-model"
						class="w-full"
						disabled={!dialog.hasModels}
						aria-label={m.settings_api_provider_dialog_default_model()}
					>
						{dialog.defaultModelLabel}
					</Select.Trigger>
					<Select.Content>
						{#each dialog.modelOptions as model (model.value)}
							<Select.Item value={model.value} label={model.label}>{model.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="grid gap-2">
				<div class="flex items-center justify-between gap-3">
					<label class="text-sm font-medium" for="api-provider-models"
						>{m.settings_api_provider_dialog_models()}</label
					>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onclick={() => dialog.fetchModels()}
						disabled={!dialog.canFetchModels}
					>
						<RefreshCwIcon class="mr-1 size-3.5" />
						{dialog.isFetchingModels
							? m.settings_api_provider_dialog_fetching_models()
							: m.settings_api_provider_dialog_fetch_models()}
					</Button>
				</div>
				<Textarea
					id="api-provider-models"
					class="h-40 max-h-60 resize-y overflow-y-auto [field-sizing:fixed]"
					value={dialog.modelsText}
					oninput={handleModelsInput}
					rows={6}
					placeholder={m.settings_api_provider_dialog_models_placeholder()}
				/>
			</div>

			<div class="flex items-center justify-between rounded-lg border border-border p-3">
				<div>
					<div class="text-sm font-medium">{m.settings_api_provider_dialog_supports_images()}</div>
					<div class="text-xs text-muted-foreground">
						{m.settings_api_provider_dialog_supports_images_description()}
					</div>
				</div>
				<Switch
					checked={dialog.supportsImages}
					onCheckedChange={(checked) => {
						dialog.supportsImages = Boolean(checked);
					}}
					aria-label={m.settings_api_provider_dialog_supports_images()}
				/>
			</div>

			{#if dialog.usesOpenAiCapabilityToggles}
				<label class="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
					<div>
						<div class="text-sm font-medium">
							{m.settings_api_provider_capability_chat_completions_label()}
						</div>
						<div class="text-xs text-muted-foreground">
							{m.settings_api_provider_capability_chat_completions_description()}
						</div>
					</div>
					<Switch
						checked={dialog.supportsChatCompletionsApi}
						onCheckedChange={(checked) => dialog.setSupportsChatCompletionsApi(Boolean(checked))}
						aria-label={m.settings_api_provider_capability_chat_completions_label()}
					/>
				</label>

				<label class="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
					<div>
						<div class="text-sm font-medium">
							{m.settings_api_provider_capability_responses_label()}
						</div>
						<div class="text-xs text-muted-foreground">
							{m.settings_api_provider_capability_responses_description()}
						</div>
					</div>
					<Switch
						checked={dialog.supportsResponsesApi}
						onCheckedChange={(checked) => dialog.setSupportsResponsesApi(Boolean(checked))}
						aria-label={m.settings_api_provider_capability_responses_label()}
					/>
				</label>
			{/if}

			{#if dialog.error}
				<div
					class="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					{dialog.error}
				</div>
			{/if}

			{#if dialog.testMessage}
				<div
					class="rounded border border-status-success-border bg-status-success px-3 py-2 text-sm text-status-success-foreground"
				>
					{dialog.testMessage}
				</div>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => onOpenChange(false)}
					>{m.settings_api_provider_dialog_cancel()}</Button
				>
				<Button
					type="button"
					variant="outline"
					onclick={() => dialog.test()}
					disabled={!dialog.canTest}
				>
					{dialog.isTesting
						? m.settings_api_provider_dialog_testing()
						: `Test from ${executors.label(executorId)}`}
				</Button>
				<Button type="submit" disabled={!dialog.canSave}>
					{dialog.isSaving
						? m.settings_api_provider_dialog_saving()
						: m.settings_api_provider_dialog_save()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
