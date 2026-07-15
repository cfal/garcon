<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import Check from '@lucide/svelte/icons/check';
	import Pencil from '@lucide/svelte/icons/pencil';
	import {
		DEFAULT_APP_TITLE,
		type AppIdentityUiSettings,
		type RemoteUiSettings,
	} from '$shared/settings';

	const remoteSettings = getRemoteSettings();

	let titleDraft = $state(DEFAULT_APP_TITLE);
	let saveError = $state<string | null>(null);
	let isSaving = $state(false);
	let titleDialogOpen = $state(false);
	let dialogError = $state<string | null>(null);
	let titleInputRef = $state<HTMLInputElement | null>(null);

	let persistedIdentity = $derived<AppIdentityUiSettings>(
		remoteSettings.snapshot?.ui.appIdentity ?? {},
	);
	let persistedTitle = $derived(persistedIdentity.title?.trim() ?? '');
	let titleEnabled = $derived(Boolean(persistedTitle));
	let displayTitle = $derived(persistedTitle || DEFAULT_APP_TITLE);

	async function persistAppIdentity(appIdentity: AppIdentityUiSettings): Promise<boolean> {
		saveError = null;
		isSaving = true;
		try {
			const ui = { appIdentity } satisfies Partial<RemoteUiSettings>;
			await remoteSettings.update({ ui });
			return true;
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		} finally {
			isSaving = false;
		}
	}

	async function handleTitleToggle(checked: boolean | string): Promise<void> {
		saveError = null;
		dialogError = null;
		const enabled = Boolean(checked);
		await persistAppIdentity(enabled ? { title: displayTitle } : {});
	}

	function openTitleDialog(): void {
		titleDraft = displayTitle;
		dialogError = null;
		titleDialogOpen = true;
	}

	function handleTitleDialogOpenChange(open: boolean): void {
		titleDialogOpen = open;
		if (!open) dialogError = null;
	}

	async function submitTitleDialog(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		dialogError = null;
		const title = titleDraft.trim();
		if (!title) {
			dialogError = m.settings_app_title_required();
			return;
		}
		const saved = await persistAppIdentity({ title });
		if (saved) titleDialogOpen = false;
	}
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4 py-3 space-y-3">
	{#if saveError}
		<div
			class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{saveError}
		</div>
	{/if}

	<div class="flex items-center justify-between gap-3">
		<div class="min-w-0">
			<label for="custom-app-title" class="text-sm font-medium text-foreground">
				{m.settings_use_custom_app_title()}
			</label>
			<div class="mt-0.5 text-xs text-muted-foreground">
				{m.settings_app_title_refresh_hint()}
			</div>
		</div>
		<Switch
			id="custom-app-title"
			checked={titleEnabled}
			disabled={isSaving}
			onCheckedChange={(checked) => handleTitleToggle(checked)}
		/>
	</div>

	{#if titleEnabled}
		<div class="block space-y-1">
			<div id="custom-app-title-value-label" class="text-xs font-medium text-muted-foreground">
				{m.settings_app_title()}
			</div>
			<button
				type="button"
				class="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-1 text-left text-sm shadow-xs transition-[color,box-shadow] outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
				aria-label={m.settings_app_title_edit_aria({ title: displayTitle })}
				disabled={isSaving}
				onclick={openTitleDialog}
			>
				<span id="custom-app-title-value" class="min-w-0 truncate">{displayTitle}</span>
				<Pencil class="size-4 text-muted-foreground" aria-hidden="true" />
			</button>
		</div>
	{/if}
</div>

<Dialog.Root open={titleDialogOpen} onOpenChange={handleTitleDialogOpenChange}>
	<Dialog.Content
		class="sm:max-w-md"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			titleInputRef?.focus();
			titleInputRef?.select();
		}}
	>
		<form class="space-y-4" onsubmit={submitTitleDialog}>
			<Dialog.Header>
				<Dialog.Title>{m.settings_app_title_dialog_title()}</Dialog.Title>
				<Dialog.Description>{m.settings_app_title_dialog_description()}</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-1">
				<label for="custom-app-title-dialog-value" class="text-sm font-medium text-foreground">
					{m.settings_app_title()}
				</label>
				<Input
					id="custom-app-title-dialog-value"
					bind:ref={titleInputRef}
					bind:value={titleDraft}
					aria-invalid={dialogError ? 'true' : undefined}
					disabled={isSaving}
				/>
				{#if dialogError}
					<div class="text-sm text-destructive">{dialogError}</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					disabled={isSaving}
					onclick={() => handleTitleDialogOpenChange(false)}
				>
					{m.sidebar_actions_cancel()}
				</Button>
				<Button type="submit" disabled={isSaving}>
					<Check class="size-4" />
					{isSaving ? m.settings_app_title_dialog_applying() : m.settings_app_title_dialog_done()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
