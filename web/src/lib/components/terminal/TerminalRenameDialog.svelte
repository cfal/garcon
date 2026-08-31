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

	let title = $state('');
	let input = $state<HTMLInputElement | null>(null);
	let activeTerminalId = $state<string | null>(null);
	let saving = $state(false);
	let error = $state<string | null>(null);
	const open = $derived(terminal !== null);
	const defaultName = $derived(
		terminal ? defaultTerminalDisplayName(terminal) : m.workspace_surface_terminal(),
	);

	$effect(() => {
		const target = terminal;
		if (!target) {
			activeTerminalId = null;
			return;
		}
		if (activeTerminalId === target.terminalId) return;
		activeTerminalId = target.terminalId;
		title = target.title ?? '';
		error = null;
	});

	$effect(() => {
		if (!input || !activeTerminalId) return;
		input.focus();
		input.select();
	});

	function handleOpenChange(nextOpen: boolean): void {
		if (!nextOpen && !saving) onClose();
	}

	async function submit(): Promise<void> {
		const target = terminal;
		if (!target || saving) return;
		saving = true;
		error = null;
		try {
			await onRename(target.terminalId, title);
			onClose();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : m.terminal_rename_failed();
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content>
		<form
			class="grid gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<Dialog.Header>
				<Dialog.Title>{m.terminal_rename_title()}</Dialog.Title>
				<Dialog.Description
					>{m.terminal_rename_description({ name: defaultName })}</Dialog.Description
				>
				<input
					bind:this={input}
					type="text"
					bind:value={title}
					maxlength={TERMINAL_TITLE_MAX_LENGTH}
					autocomplete="off"
					aria-label={m.terminal_name()}
					class="w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:pointer-fine:text-sm"
				/>
				{#if error}
					<p class="text-sm text-destructive" role="alert">{error}</p>
				{/if}
			</Dialog.Header>
			<Dialog.Footer>
				<Button type="button" variant="outline" disabled={saving} onclick={onClose}
					>{m.common_cancel()}</Button
				>
				<Button type="submit" disabled={saving}>{m.sidebar_actions_save()}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
