<script lang="ts">
	import { tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import DirectoryBrowser from '$lib/components/chat/DirectoryBrowser.svelte';
	import PromptEditorDialog from '$lib/components/prompt-editor/PromptEditorDialog.svelte';
	import PromptTextField from '$lib/components/prompt-editor/PromptTextField.svelte';
	import { PromptEditorDialogState } from '$lib/prompt-editor/prompt-editor-dialog-state.svelte.js';
	import {
		promptEditorSelectionFromTextarea,
		restorePromptEditorSelection,
		type PromptEditorSelection,
	} from '$lib/prompt-editor/prompt-editor-selection.js';
	import { getAppShell } from '$lib/context';
	import {
		PREAMBLE_CHAT_ID_TOKEN,
		type Preamble,
		type PreambleDefinitionInput,
	} from '$shared/preambles';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import * as m from '$lib/paraglide/messages.js';
	import { PreambleFormState } from './preamble-form-state.svelte.js';

	interface Props {
		open: boolean;
		preamble: Preamble | null;
		isStale: boolean;
		onSave: (definition: PreambleDefinitionInput) => Promise<void>;
		onClose: () => void;
	}

	let { open, preamble, isStale, onSave, onClose }: Props = $props();
	const appShell = getAppShell();
	const form = new PreambleFormState();
	let pickerKey = $state<string | null>(null);
	let pickerFocusReturnTarget: HTMLElement | null = null;
	let contentTextarea = $state<HTMLTextAreaElement | null>(null);
	const contentEditor = new PromptEditorDialogState();

	$effect(() => {
		if (!open) return;
		form.reset(preamble);
		pickerKey = null;
		pickerFocusReturnTarget = null;
		contentEditor.close();
	});

	function errorDetail(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async function save(): Promise<void> {
		if (isStale) return;
		const definition = form.buildDefinition();
		if (!definition || form.saving) return;
		form.saving = true;
		form.error = null;
		try {
			await onSave(definition);
			onClose();
		} catch (error) {
			form.error = m.preambles_save_error({ detail: errorDetail(error) });
		} finally {
			form.saving = false;
		}
	}

	function closeForm(): void {
		if (form.saving) return;
		pickerKey = null;
		pickerFocusReturnTarget = null;
		contentEditor.close();
		onClose();
	}

	function openPathPicker(key: string): void {
		pickerFocusReturnTarget =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		pickerKey = key;
	}

	function closePathPicker(): void {
		pickerKey = null;
		const focusTarget = pickerFocusReturnTarget;
		pickerFocusReturnTarget = null;
		queueMicrotask(() => focusTarget?.focus({ preventScroll: true }));
	}

	function addPath(): void {
		form.scopeType = 'project-paths';
		const key = form.addPath(appShell.projectBasePath);
		if (key) openPathPicker(key);
	}

	function openExpandedEditor(): void {
		if (form.saving || !contentTextarea) return;
		const selection = promptEditorSelectionFromTextarea(contentTextarea);
		contentTextarea.focus({ preventScroll: true });
		contentEditor.show(selection);
	}

	async function closeExpandedEditor(): Promise<void> {
		const selection = contentEditor.selection;
		contentEditor.close();
		await tick();
		if (!open || !contentTextarea) return;
		restorePromptEditorSelection(contentTextarea, selection);
		contentTextarea.focus({ preventScroll: true });
	}

	function handleExpandedTextChange(text: string): void {
		if (open && form.content !== text) form.content = text;
	}

	function handleExpandedSelectionChange(selection: PromptEditorSelection): void {
		contentEditor.updateSelection(selection);
	}

	function handleFormKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
		event.preventDefault();
		void save();
	}
</script>

<Dialog.Root {open} requestClose={closeForm}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-screen sm:max-w-none sm:pointer-fine:top-[50%] sm:pointer-fine:h-[min(48rem,calc(var(--app-height)-2rem))] sm:pointer-fine:max-h-[48rem] sm:pointer-fine:w-[calc(100vw-2rem)] sm:pointer-fine:max-w-3xl sm:pointer-fine:rounded-lg sm:pointer-fine:border"
		showCloseButton={false}
	>
		<Dialog.Header class="shrink-0 border-b border-border bg-background px-5 py-4 sm:px-6">
			<Dialog.Title>
				{preamble ? m.preambles_edit_title() : m.preambles_add_title()}
			</Dialog.Title>
			<Dialog.Description>{m.preambles_form_description()}</Dialog.Description>
		</Dialog.Header>

		<div
			data-slot="preambles-scroll-body"
			class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6"
			inert={form.saving}
			aria-busy={form.saving}
		>
			<div class="flex items-center justify-between gap-4 rounded-md border border-border p-3">
				<div class="min-w-0">
					<label for="preamble-enabled" class="text-sm font-medium text-foreground">
						{m.preambles_enabled_label()}
					</label>
					<p class="text-xs text-muted-foreground">{m.preambles_enabled_description()}</p>
				</div>
				<Switch id="preamble-enabled" bind:checked={form.enabled} disabled={form.saving} />
			</div>

			<div class="space-y-1.5">
				<label for="preamble-title" class="text-sm font-medium text-foreground">
					{m.preambles_title_label()}
				</label>
				<input
					id="preamble-title"
					type="text"
					bind:value={form.title}
					autocomplete="off"
					aria-invalid={Boolean(form.titleError)}
					aria-describedby="preamble-title-error"
					class="h-10 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				/>
				<p id="preamble-title-error" class="min-h-4 text-xs text-destructive">
					{form.titleError ?? ''}
				</p>
			</div>

			<fieldset
				class="space-y-3"
				aria-describedby={form.scopeGroupError ? 'preamble-scope-error' : undefined}
			>
				<legend class="text-sm font-medium text-foreground">{m.preambles_scope_label()}</legend>
				<div class="grid gap-2 sm:grid-cols-2">
					<label class="flex cursor-pointer gap-3 rounded-md border border-border p-3">
						<input type="radio" name="preamble-scope" value="global" bind:group={form.scopeType} />
						<span>
							<span class="block text-sm font-medium">{m.preambles_scope_global()}</span>
							<span class="block text-xs text-muted-foreground">
								{m.preambles_scope_global_description()}
							</span>
						</span>
					</label>
					<label class="flex cursor-pointer gap-3 rounded-md border border-border p-3">
						<input
							type="radio"
							name="preamble-scope"
							value="project-paths"
							bind:group={form.scopeType}
						/>
						<span>
							<span class="block text-sm font-medium">{m.preambles_scope_projects()}</span>
							<span class="block text-xs text-muted-foreground">
								{m.preambles_scope_projects_description()}
							</span>
						</span>
					</label>
				</div>

				{#if form.scopeType === 'project-paths'}
					<div class="space-y-3">
						{#each form.pathRules as rule (rule.key)}
							{@const pathError = form.pathRuleError(rule.key)}
							<div class="relative space-y-2 rounded-md border border-border p-3">
								<div class="flex min-w-0 gap-2">
									<input
										type="text"
										bind:value={rule.projectPath}
										aria-label={m.preambles_project_path_label()}
										aria-invalid={Boolean(pathError)}
										aria-describedby={pathError ? `preamble-path-error-${rule.key}` : undefined}
										class="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
									/>
									<Button
										type="button"
										variant="secondary"
										size="icon"
										onclick={() => {
											if (pickerKey === rule.key) closePathPicker();
											else openPathPicker(rule.key);
										}}
										aria-label={m.preambles_browse_path()}
										title={m.preambles_browse_path()}
									>
										<FolderOpen class="h-4 w-4" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onclick={() => form.removePath(rule.key)}
										aria-label={m.preambles_remove_path()}
										title={m.preambles_remove_path()}
									>
										<Trash2 class="h-4 w-4" />
									</Button>
								</div>
								<label class="flex items-center gap-2 text-sm">
									<input type="checkbox" bind:checked={rule.includeNested} />
									{m.preambles_apply_nested()}
								</label>
								<p id={`preamble-path-error-${rule.key}`} class="min-h-4 text-xs text-destructive">
									{pathError ?? ''}
								</p>
								{#if pickerKey === rule.key}
									<DirectoryBrowser
										currentPath={rule.projectPath || appShell.projectBasePath}
										basePath={appShell.projectBasePath}
										onSelect={(projectPath) => form.setPath(rule.key, projectPath)}
										onClose={closePathPicker}
										isMobile={appShell.isMobile}
									/>
								{/if}
							</div>
						{/each}
						<Button type="button" variant="secondary" onclick={addPath} disabled={!form.canAddPath}>
							<Plus class="mr-2 h-4 w-4" />
							{m.preambles_add_path()}
						</Button>
						<p id="preamble-scope-error" class="min-h-4 text-xs text-destructive">
							{form.scopeGroupError ?? ''}
						</p>
					</div>
				{/if}
			</fieldset>

			<div class="space-y-1.5">
				<label for="preamble-content" class="text-sm font-medium text-foreground">
					{m.preambles_content_label()}
				</label>
				<PromptTextField
					id="preamble-content"
					bind:ref={contentTextarea}
					bind:value={form.content}
					onkeydown={handleFormKeyDown}
					rows={12}
					placeholder={m.preambles_content_placeholder()}
					invalid={Boolean(form.contentError)}
					readOnly={false}
					describedBy="preamble-content-help preamble-content-error"
					textareaClass="min-h-48 font-mono"
					canExpand={!form.saving}
					expandLabel={m.preambles_expand_editor()}
					canRefinePrompt={false}
					isPromptRefinementPending={false}
					onExpand={openExpandedEditor}
					onRefinePrompt={() => {}}
				/>
				<p id="preamble-content-help" class="text-xs text-muted-foreground">
					{m.preambles_content_chat_id_help({ token: PREAMBLE_CHAT_ID_TOKEN })}
				</p>
				<p id="preamble-content-error" class="min-h-4 text-xs text-destructive">
					{form.contentError ?? ''}
				</p>
			</div>

			{#if isStale}
				<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{m.preambles_edit_stale()}
				</p>
			{/if}
			{#if form.error}
				<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{form.error}
				</p>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0 border-t border-border bg-background px-5 py-4 sm:px-6">
			<Button variant="secondary" onclick={closeForm} disabled={form.saving}>
				{m.preambles_cancel()}
			</Button>
			<Button onclick={() => void save()} disabled={!form.canSave || isStale}>
				{form.saving ? m.preambles_saving() : m.preambles_save()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if open && contentEditor.open}
	<PromptEditorDialog
		title={m.preambles_editor_title()}
		editorLabel={m.preambles_content_label()}
		text={form.content}
		selection={contentEditor.selection}
		focusRequestId={contentEditor.focusRequestId}
		readOnly={false}
		canRefinePrompt={false}
		isPromptRefinementPending={false}
		onTextChange={handleExpandedTextChange}
		onSelectionChange={handleExpandedSelectionChange}
		onRefinePrompt={() => {}}
		onClose={() => void closeExpandedEditor()}
	/>
{/if}
