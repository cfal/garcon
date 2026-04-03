<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { SavedChatSearch } from '$lib/api/settings';

	export interface SavedSearchEditorState {
		mode: 'create' | 'edit';
		searchId?: string;
		title: string;
		query: string;
		showInQuickMenu: boolean;
	}

	interface SavedSearchEditorDialogProps {
		editorState: SavedSearchEditorState | null;
		onClose: () => void;
		onSave: (data: { title: string | null; query: string; showInQuickMenu: boolean }, searchId?: string) => Promise<void>;
	}

	let {
		editorState,
		onClose,
		onSave,
	}: SavedSearchEditorDialogProps = $props();

	let isOpen = $derived(editorState !== null);
	let titleValue = $state('');
	let queryValue = $state('');
	let showInQuickMenuValue = $state(false);
	let validationError = $state<string | null>(null);
	let isSaving = $state(false);
	let inputRef = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (editorState) {
			titleValue = editorState.title;
			queryValue = editorState.query;
			showInQuickMenuValue = editorState.showInQuickMenu;
			validationError = null;
			isSaving = false;
		}
	});

	$effect(() => {
		if (inputRef && editorState) {
			inputRef.focus();
		}
	});

	function validate(): string | null {
		if (!queryValue.trim()) return m.sidebar_saved_searches_query_required();
		if (showInQuickMenuValue && !titleValue.trim()) {
			return m.sidebar_saved_searches_title_required_for_quick_menu();
		}
		return null;
	}

	async function handleSave() {
		const error = validate();
		if (error) {
			validationError = error;
			return;
		}
		isSaving = true;
		try {
			const title = titleValue.trim() || null;
			const query = queryValue.trim();
			await onSave({ title, query, showInQuickMenu: showInQuickMenuValue }, editorState?.searchId);
		} catch (err) {
			validationError = err instanceof Error ? err.message : String(err);
		} finally {
			isSaving = false;
		}
	}

	function handleOpenChange(open: boolean) {
		if (!open && !isSaving) onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSave();
		}
	}

	let dialogTitle = $derived(
		editorState?.mode === 'edit'
			? m.sidebar_saved_searches_edit_dialog_title()
			: m.sidebar_saved_searches_add_dialog_title()
	);
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="h-dvh w-full max-w-full rounded-none border-0 p-6 sm:h-auto sm:max-w-md sm:rounded-lg sm:border">
		<Dialog.Header>
			<Dialog.Title>{dialogTitle}</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-4">
			<label class="block space-y-1.5">
				<span class="text-sm font-medium text-foreground">{m.sidebar_saved_searches_query_label()}</span>
				<Input
					bind:ref={inputRef}
					type="text"
					bind:value={queryValue}
					placeholder={m.sidebar_saved_searches_query_placeholder()}
					disabled={isSaving}
					onkeydown={handleKeydown}
				/>
			</label>

			<label class="block space-y-1.5">
				<span class="text-sm font-medium text-foreground">{m.sidebar_saved_searches_title_label()}</span>
				<Input
					type="text"
					bind:value={titleValue}
					placeholder={m.sidebar_saved_searches_title_placeholder()}
					disabled={isSaving}
					onkeydown={handleKeydown}
				/>
			</label>

			<label class="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					bind:checked={showInQuickMenuValue}
					disabled={isSaving}
					class="rounded border-border"
				/>
				{m.sidebar_saved_searches_show_in_quick_menu()}
			</label>

			{#if validationError}
				<p class="text-sm text-destructive">{validationError}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose} disabled={isSaving}>{m.sidebar_actions_cancel()}</Button>
			<Button onclick={handleSave} disabled={isSaving || !queryValue.trim()}>{m.sidebar_actions_save()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
