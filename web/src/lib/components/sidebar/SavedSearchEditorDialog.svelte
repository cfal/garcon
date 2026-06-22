<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import type { SavedSearchEditorState, SavedSearchInput } from '$lib/stores/sidebar-search.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface SavedSearchEditorDialogProps {
		editorState: SavedSearchEditorState | null;
		onClose: () => void;
		onSave: (data: SavedSearchInput, searchId?: string) => Promise<void>;
	}

	let { editorState, onClose, onSave }: SavedSearchEditorDialogProps = $props();

	let isOpen = $derived(editorState !== null);
	let titleValue = $state('');
	let queryValue = $state('');
	let showAsSidebarPillValue = $state(false);
	let showInSidebarMenuValue = $state(false);
	let showInSearchDialogValue = $state(true);
	let validationError = $state<string | null>(null);
	let isSaving = $state(false);
	let inputRef = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (editorState) {
			titleValue = editorState.title;
			queryValue = editorState.query;
			showAsSidebarPillValue = editorState.showAsSidebarPill;
			showInSidebarMenuValue = editorState.showInSidebarMenu;
			showInSearchDialogValue = editorState.showInSearchDialog;
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
		if (!showAsSidebarPillValue && !showInSidebarMenuValue && !showInSearchDialogValue) {
			return 'At least one visibility option is required';
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
			await onSave(
				{
					title,
					query,
					showAsSidebarPill: showAsSidebarPillValue,
					showInSidebarMenu: showInSidebarMenuValue,
					showInSearchDialog: showInSearchDialogValue,
				},
				editorState?.searchId,
			);
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
			: m.sidebar_saved_searches_add_dialog_title(),
	);
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="h-dvh w-full max-w-full rounded-none border-0 p-6 sm:h-auto sm:max-w-md sm:rounded-lg sm:border"
	>
		<Dialog.Header>
			<Dialog.Title>{dialogTitle}</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-4">
			<label class="block space-y-1.5">
				<span class="text-sm font-medium text-foreground"
					>{m.sidebar_saved_searches_query_label()}</span
				>
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
				<span class="text-sm font-medium text-foreground"
					>{m.sidebar_saved_searches_title_label()}</span
				>
				<Input
					type="text"
					bind:value={titleValue}
					placeholder={m.sidebar_saved_searches_title_placeholder()}
					disabled={isSaving}
					onkeydown={handleKeydown}
				/>
			</label>

			<div class="space-y-2">
				<span class="text-sm font-medium text-foreground">Visibility</span>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={showAsSidebarPillValue}
						disabled={isSaving}
						class="rounded border-border"
					/>
					Show as sidebar pill
				</label>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={showInSidebarMenuValue}
						disabled={isSaving}
						class="rounded border-border"
					/>
					Show in sidebar menu
				</label>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={showInSearchDialogValue}
						disabled={isSaving}
						class="rounded border-border"
					/>
					Show in search dialog
				</label>
			</div>

			{#if validationError}
				<p class="text-sm text-destructive">{validationError}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose} disabled={isSaving}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button onclick={handleSave} disabled={isSaving || !queryValue.trim()}
				>{m.sidebar_actions_save()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
