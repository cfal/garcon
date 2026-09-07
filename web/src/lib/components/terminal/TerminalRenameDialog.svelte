<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { defaultTerminalDisplayName } from '$lib/terminal/sessions/terminal-display-name.js';
	import { TERMINAL_TITLE_MAX_LENGTH, type TerminalMetadata } from '$shared/terminal';
	import * as m from '$lib/paraglide/messages.js';

	let {
		terminal,
		onClose,
		onRename,
	}: {
		terminal: TerminalMetadata | null;
		onClose: () => void;
		onRename: (terminalId: string, title: string) => Promise<void>;
	} = $props();

	let titleDraft = $state('');
	let titleInput = $state<HTMLInputElement | null>(null);
	let draftTerminalId = $state<string | null>(null);
	let isSaving = $state(false);
	let renameError = $state<string | null>(null);
	const open = $derived(terminal !== null);
	const defaultName = $derived(
		terminal ? defaultTerminalDisplayName(terminal) : m.workspace_surface_terminal(),
	);

	$effect(() => {
		const target = terminal;
		if (!target) {
			draftTerminalId = null;
			return;
		}
		if (draftTerminalId === target.terminalId) return;
		draftTerminalId = target.terminalId;
		titleDraft = target.title ?? '';
		renameError = null;
	});

	$effect(() => {
		if (!titleInput || !draftTerminalId) return;
		titleInput.focus();
		titleInput.select();
	});

	async function submitRename(): Promise<void> {
		const target = terminal;
		if (!target || isSaving) return;
		isSaving = true;
		renameError = null;
		try {
			await onRename(target.terminalId, titleDraft);
			onClose();
		} catch (cause) {
			renameError = cause instanceof Error ? cause.message : m.terminal_rename_failed();
		} finally {
			isSaving = false;
		}
	}
</script>

<Dialog.Root {open} requestClose={() => !isSaving && onClose()}>
	<Dialog.Content>
		<form
			class="grid gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				void submitRename();
			}}
		>
			<Dialog.Header>
				<Dialog.Title>{m.terminal_rename_title()}</Dialog.Title>
				<Dialog.Description
					>{m.terminal_rename_description({ name: defaultName })}</Dialog.Description
				>
				<input
					bind:this={titleInput}
					type="text"
					bind:value={titleDraft}
					maxlength={TERMINAL_TITLE_MAX_LENGTH}
					autocomplete="off"
					aria-label={m.terminal_name()}
					class="w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:pointer-fine:text-sm"
				/>
				{#if renameError}
					<p class="text-sm text-destructive" role="alert">{renameError}</p>
				{/if}
			</Dialog.Header>
			<Dialog.Footer>
				<Button type="button" variant="outline" disabled={isSaving} onclick={onClose}
					>{m.common_cancel()}</Button
				>
				<Button type="submit" disabled={isSaving}>{m.sidebar_actions_save()}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
