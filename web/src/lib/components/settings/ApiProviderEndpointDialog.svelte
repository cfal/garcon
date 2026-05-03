<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Switch } from '$lib/components/ui/switch';
	import { untrack } from 'svelte';
	import { getModelCatalog } from '$lib/context';
	import type { ApiProtocol } from '$shared/providers';
	import type { ApiProviderTemplateId } from '$shared/api-provider-templates';
	import { ApiProviderEndpointDialogState } from './api-provider-endpoint-dialog-state.svelte';

	let {
		open = false,
		protocol,
		endpointId = null,
		templateId = 'custom',
		onOpenChange = () => undefined
	} = $props<{
		open?: boolean;
		protocol: ApiProtocol;
		endpointId?: string | null;
		templateId?: ApiProviderTemplateId;
		onOpenChange?: (open: boolean) => void;
	}>();

	const modelCatalog = getModelCatalog();
	const dialog = new ApiProviderEndpointDialogState({
		modelCatalog,
		getProtocol: () => protocol,
		getEndpointId: () => endpointId,
		getTemplateId: () => templateId,
		onSaved: () => onOpenChange(false)
	});

	$effect(() => {
		dialog.open = open;
		if (open) {
			untrack(() => {
				void dialog.load();
			});
		}
	});

	function handleOpenChange(next: boolean) {
		onOpenChange(next);
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="h-dvh w-full max-w-full rounded-none border-0 p-0 sm:h-auto sm:max-w-3xl sm:rounded-lg sm:border">
		<Dialog.Header class="border-b border-border px-6 py-4">
			<Dialog.Title>{dialog.title}</Dialog.Title>
			<Dialog.Description>{dialog.description}</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4 p-6" onsubmit={(event) => { event.preventDefault(); void dialog.save(); }}>
			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-label">Display name</label>
				<Input id="api-provider-label" bind:value={dialog.label} />
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-base-url">Base URL</label>
				<Input id="api-provider-base-url" bind:value={dialog.baseUrl} placeholder={dialog.baseUrlPlaceholder} />
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-api-key">API key or token</label>
				<Input
					id="api-provider-api-key"
					type="password"
					bind:value={dialog.apiKey}
					autocomplete="off"
					placeholder={dialog.apiKeyPlaceholder}
				/>
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-default-model">Default model</label>
				<Input id="api-provider-default-model" bind:value={dialog.defaultModel} />
			</div>

			<div class="grid gap-2">
				<label class="text-sm font-medium" for="api-provider-models">Models</label>
				<Textarea id="api-provider-models" bind:value={dialog.modelsText} rows={6} />
			</div>

			<div class="flex items-center justify-between rounded-lg border border-border p-3">
				<div>
					<div class="text-sm font-medium">Supports images</div>
					<div class="text-xs text-muted-foreground">Allows image attachments when this model is selected.</div>
				</div>
				<Switch checked={dialog.supportsImages} onCheckedChange={(checked) => { dialog.supportsImages = Boolean(checked); }} />
			</div>

			{#each dialog.targetOptions as target (target.harnessId)}
				<div class="flex items-center justify-between rounded-lg border border-border p-3">
					<div>
						<div class="text-sm font-medium">{target.label}</div>
						<div class="text-xs text-muted-foreground">{target.description}</div>
					</div>
					<Switch
						checked={dialog.isTargetEnabled(target.harnessId)}
						onCheckedChange={(checked) => dialog.setTarget(target.harnessId, Boolean(checked))}
					/>
				</div>
			{/each}

			{#if dialog.error}
				<div class="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{dialog.error}
				</div>
			{/if}

			{#if dialog.testMessage}
				<div class="rounded border border-status-success-border bg-status-success px-3 py-2 text-sm text-status-success-foreground">
					{dialog.testMessage}
				</div>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
				<Button type="button" variant="outline" onclick={() => dialog.test()} disabled={dialog.isTesting || !dialog.canSave}>
					{dialog.isTesting ? 'Testing...' : 'Test'}
				</Button>
				<Button type="submit" disabled={!dialog.canSave}>
					{dialog.isSaving ? 'Saving...' : 'Save'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
