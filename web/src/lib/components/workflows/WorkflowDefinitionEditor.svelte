<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import CodeXml from '@lucide/svelte/icons/code-xml';
	import List from '@lucide/svelte/icons/list';
	import Plus from '@lucide/svelte/icons/plus';
	import Redo2 from '@lucide/svelte/icons/redo-2';
	import Save from '@lucide/svelte/icons/save';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import FileConflictComparison from '$lib/components/files/FileConflictComparison.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { isRecord, type JsonValue } from '$shared/json';
	import {
		getWorkflowDefinitionFieldValue,
		WORKFLOW_DEFINITION_LIMITS,
		type WorkflowSourceRange,
		type WorkflowStep,
	} from '$shared/workflow-definition';
	import {
		nextWorkflowStepId,
		workflowSignalSubscription,
		workflowSignals,
	} from '$lib/workflows/definition/workflow-step-options';
	import { workflowEdges, type WorkflowGraphFocus } from '$lib/workflows/definition/workflow-graph';
	import { workflowFieldEdits } from '$lib/workflows/definition/workflow-field-edits';
	import type { WorkflowDraftState } from '$lib/workflows/definition/workflow-draft-state.svelte';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
	import { lazyRenderer } from '$lib/utils/lazy-renderer';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region';
	import WorkflowShareDialog from './WorkflowShareDialog.svelte';
	import WorkflowSplitView, { focusWorkflowDetail } from './WorkflowSplitView.svelte';
	import WorkflowStepInspector from './WorkflowStepInspector.svelte';
	import WorkflowInputsEditor from './WorkflowInputsEditor.svelte';
	import WorkflowStepList from './WorkflowStepList.svelte';
	import WorkflowStepPicker from './WorkflowStepPicker.svelte';
	import { workflowStepKindLabel } from './workflow-labels';

	let {
		draft,
		context,
		busy,
		onPendingChange,
		onPublish,
		onTest,
	}: {
		draft: WorkflowDraftState;
		context: WorkflowLaunchContext | null;
		busy: boolean;
		onPendingChange?: (pending: boolean) => void;
		onPublish: () => void;
		onTest: () => void;
	} = $props();

	const graph = lazyRenderer(() => import('./WorkflowGraph.svelte'));
	const editor = lazyRenderer(() =>
		import('./WorkflowSourceEditor.svelte').catch((error) => {
			console.error('Failed to load workflow source editor', error);
			throw error;
		}),
	);
	let view = $state<'outline' | 'graph' | 'source'>('outline');
	let editing = $state(true);
	let detailOpen = $state(false);
	let width = $state(0);
	let root = $state<HTMLElement>();
	let heading = $state<HTMLHeadingElement>();
	let selected = $state<string | null>(null);
	let focusRequest = $state.raw<WorkflowGraphFocus | null>(null);
	let location = $state.raw<WorkflowSourceRange | null>(null);
	let picker = $state<{ signal?: string; after?: string } | null>(null);
	let sharing = $state(false);
	const current = $derived(draft.result.definition);
	const definition = $derived(current ?? draft.lastValid);
	const file = $derived(draft.file);
	const active = $derived(definition?.steps.find(({ id }) => id === selected));
	const steps = $derived(
		definition?.steps.map(({ id, name, kind }) => ({ id, title: name ?? id, kind })) ?? [],
	);
	const edges = $derived(workflowEdges(definition?.steps ?? []));
	const editable = $derived(Boolean(current && editing && !busy && !file?.comparison));
	const canAdd = $derived(editable && steps.length < WORKFLOW_DEFINITION_LIMITS.steps);
	const authoredName = $derived(current?.name ?? '');
	let definitionName = $derived(authoredName);
	type PendingFlush = 'clean' | 'applied' | 'blocked';
	type PendingControl = {
		flushPending(): PendingFlush;
		discardPending(): void;
	};
	let inputsRef = $state<PendingControl>();
	let stepRef = $state<PendingControl>();
	let pendingInputs = $state(false);
	let pendingStep = $state(false);
	let unappliedGuard = $state.raw<(() => void) | null>(null);
	const nameDirty = $derived(editable && Boolean(current) && definitionName !== authoredName);
	const hasPendingEdits = $derived(nameDirty || pendingInputs || pendingStep);

	$effect(() => {
		onPendingChange?.(hasPendingEdits);
	});

	onDestroy(() => {
		onPendingChange?.(false);
	});

	export function flushPending(): PendingFlush {
		if (!editable || !current) return 'clean';
		let applied = false;
		if (nameDirty) {
			const trimmed = definitionName.trim();
			if (!trimmed) return 'blocked';
			if (trimmed !== current.name) {
				if (!draft.edit([{ kind: 'upsert', path: ['name'], value: trimmed }])) return 'blocked';
				applied = true;
			} else {
				definitionName = authoredName;
			}
		}
		for (const child of [inputsRef, stepRef]) {
			if (!child) continue;
			const outcome = child.flushPending();
			if (outcome === 'blocked') return 'blocked';
			if (outcome === 'applied') applied = true;
		}
		return applied ? 'applied' : 'clean';
	}

	export function discardPending(): void {
		definitionName = authoredName;
		inputsRef?.discardPending();
		stepRef?.discardPending();
		pendingInputs = false;
		pendingStep = false;
	}

	function runGuarded(action: () => void): void {
		if (flushPending() === 'blocked') {
			unappliedGuard = action;
			return;
		}
		action();
	}

	function editInput(name: string, value: JsonValue | undefined): boolean {
		if (!current || !editable) return false;
		const existing = getWorkflowDefinitionFieldValue(draft.source, ['inputs']);
		const next = { ...(isRecord(existing) ? existing : {}) };
		if (value === undefined) delete next[name];
		else next[name] = value;
		return draft.edit(
			workflowFieldEdits(['inputs'], existing, Object.keys(next).length ? next : undefined),
		);
	}

	function select(id: string) {
		if (id === selected) {
			detailOpen = true;
			void tick().then(() => focusWorkflowDetail(heading));
			return;
		}
		runGuarded(() => {
			selected = id;
			detailOpen = true;
			void tick().then(() => focusWorkflowDetail(heading));
		});
	}

	function back() {
		detailOpen = false;
		if (view === 'graph' && active) {
			const request: WorkflowGraphFocus = {
				stepId: active.id,
				complete: () => {
					if (focusRequest === request) focusRequest = null;
				},
			};
			focusRequest = request;
			return;
		}
		void tick().then(() => {
			const buttons = root?.querySelectorAll<HTMLButtonElement>('[data-workflow-step]');
			const button =
				buttons && Array.from(buttons).find((entry) => entry.dataset.workflowStep === selected);
			(button ?? root?.querySelector<HTMLButtonElement>('[data-workflow-outline]'))?.focus();
		});
	}

	function editStep(id: string, fields: Readonly<Record<string, JsonValue | undefined>>): boolean {
		if (!current || !editable) return false;
		const index = current.steps.findIndex((step) => step.id === id);
		const path = ['steps', index];
		const source = getWorkflowDefinitionFieldValue(draft.source, path);
		if (index < 0 || !isRecord(source)) return false;
		return draft.edit(
			Object.entries(fields).flatMap(([key, value]) =>
				workflowFieldEdits(
					[...path, key],
					Object.hasOwn(source, key) ? source[key] : undefined,
					value,
				),
			),
		);
	}

	function insert(kind: WorkflowStep['kind']) {
		if (!current || !canAdd || !picker) return;
		const id = nextWorkflowStepId(current.steps, kind);
		const signal = workflowSignals(current.steps).find(({ value }) => value === picker?.signal);
		const after = current.steps.findIndex(({ id }) => id === picker?.after);
		const value: JsonValue = {
			id,
			kind,
			...(kind === 'command'
				? { command: 'printf "%s\\n" Done' }
				: {
						prompt:
							kind === 'agent'
								? m.workflow_studio_new_agent_prompt()
								: m.workflow_studio_new_decision_prompt(),
					}),
			...(kind === 'decision'
				? { choices: { approve: m.workflow_studio_approve(), reject: m.workflow_studio_reject() } }
				: {}),
			...(signal && { on: workflowSignalSubscription(signal) }),
		};
		if (
			draft.edit([
				after < 0
					? { kind: 'append', path: ['steps'], value }
					: { kind: 'insert', path: ['steps'], index: after + 1, value },
			])
		) {
			picker = null;
			select(id);
		}
	}

	function duplicate(step: WorkflowStep) {
		if (!current || !canAdd) return;
		const index = current.steps.findIndex(({ id }) => id === step.id);
		const source = getWorkflowDefinitionFieldValue(draft.source, ['steps', index]);
		if (!isRecord(source)) return;
		const id = nextWorkflowStepId(current.steps, step.id);
		if (
			draft.edit([{ kind: 'insert', path: ['steps'], index: index + 1, value: { ...source, id } }])
		)
			select(id);
	}

	function remove(id: string) {
		if (!current || !editable || current.steps.length < 2) return;
		const index = current.steps.findIndex((step) => step.id === id);
		if (index >= 0 && draft.edit([{ kind: 'delete', path: ['steps', index] }])) {
			selected = null;
			back();
		}
	}

	function reveal(range: WorkflowSourceRange) {
		view = 'source';
		location = { ...range };
	}
</script>

<section
	bind:this={root}
	bind:clientWidth={width}
	class="flex min-h-0 min-w-0 flex-1 flex-col"
	aria-label={m.workflow_studio_editor()}
>
	<header class="space-y-2 border-b border-border bg-card px-3 py-2">
		<div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
			<div class="min-w-0">
				<h2 class="wrap-anywhere text-sm font-semibold">
					{definition?.name ?? m.workflow_studio_definition_draft()}
				</h2>
				<p class="wrap-anywhere text-xs text-muted-foreground">
					{draft.revision
						? m.workflow_studio_revision({ revision: draft.revision })
						: m.workflow_studio_unpublished()}
					{#if draft.dirty}
						· {m.workflow_studio_unsaved()}{/if}
				</p>
			</div>
			<div class="flex flex-wrap gap-1">
				<Button
					size="sm"
					variant="outline"
					disabled={!current || busy}
					onclick={() => runGuarded(onTest)}>{m.workflow_studio_test_run()}</Button
				>
				<Button size="sm" disabled={!current || busy} onclick={() => runGuarded(onPublish)}
					>{draft.file && draft.revision === null
						? m.workflow_studio_publish_new_definition()
						: m.workflow_studio_publish()}</Button
				>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-1">
			<Button
				data-workflow-outline
				size="sm"
				variant={view === 'outline' ? 'secondary' : 'ghost'}
				aria-pressed={view === 'outline'}
				onclick={() => {
					if (view !== 'outline') runGuarded(() => (view = 'outline'));
				}}><List class="size-4" /> {m.workflow_studio_outline()}</Button
			>
			<Button
				size="sm"
				variant={view === 'graph' ? 'secondary' : 'ghost'}
				aria-pressed={view === 'graph'}
				onclick={() => {
					if (view !== 'graph') runGuarded(() => (view = 'graph'));
				}}><WorkflowIcon class="size-4" /> {m.workflow_studio_graph()}</Button
			>
			<Button
				size="sm"
				variant={view === 'source' ? 'secondary' : 'ghost'}
				aria-pressed={view === 'source'}
				onclick={() => {
					if (view !== 'source') runGuarded(() => (view = 'source'));
				}}><CodeXml class="size-4" /> {m.workflow_studio_source()}</Button
			>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label={m.workflow_studio_undo()}
				title={m.workflow_studio_undo()}
				disabled={!draft.canUndo || busy || Boolean(file?.comparison)}
				onclick={() => draft.undo()}><Undo2 class="size-4" /></Button
			>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label={m.workflow_studio_redo()}
				title={m.workflow_studio_redo()}
				disabled={!draft.canRedo || busy || Boolean(file?.comparison)}
				onclick={() => draft.redo()}><Redo2 class="size-4" /></Button
			>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label={m.workflow_studio_share_yaml()}
				title={m.workflow_studio_share_yaml()}
				disabled={!draft.source}
				onclick={() => (sharing = true)}><Share2 class="size-4" /></Button
			>
			{#if view !== 'source' && current}
				<Button
					size="sm"
					variant={editing ? 'secondary' : 'outline'}
					aria-pressed={editing}
					disabled={Boolean(file?.comparison)}
					onclick={() => {
						if (editing) runGuarded(() => (editing = false));
						else editing = true;
					}}>{m.workflow_studio_edit_graph()}</Button
				>
				{#if editing}
					<Button
						size="sm"
						variant="outline"
						disabled={!canAdd}
						onclick={() => runGuarded(() => (picker = {}))}
						><Plus class="size-4" /> {m.workflow_studio_add_step()}</Button
					>
				{/if}
			{/if}
		</div>
		{#if file}
			<div class="flex flex-wrap items-center gap-2 border-t border-border pt-2">
				<span class="min-w-0 flex-1 wrap-anywhere font-mono text-xs text-muted-foreground"
					>{file.target.executorId}: {file.target.filePath}</span
				>
				{#if file.reconcileRequired}
					<Button
						size="sm"
						variant="outline"
						disabled={file.busy || Boolean(file.comparison)}
						onclick={() => runGuarded(() => void file.compare(() => draft.source))}
						>{m.workflow_studio_compare_disk()}</Button
					>
				{:else}
					<Button
						size="sm"
						variant="outline"
						disabled={file.busy || (!draft.dirty && !hasPendingEdits)}
						onclick={() =>
							runGuarded(() => {
								if (draft.dirty) void file.save(draft.source);
							})}
						><Save class="size-4" /> {m.workflow_studio_save_file()}</Button
					>
				{/if}
			</div>
		{/if}
	</header>

	{#if file?.error}
		<p role="alert" class="border-b border-border px-3 py-2 text-sm text-destructive">
			{file.error instanceof Error ? file.error.message : m.workflow_studio_action_failed()}
			{#if file.reconcileRequired}
				{m.workflow_studio_compare_required()}{/if}
		</p>
	{/if}
	{#if draft.result.diagnostics.length}
		<div
			class="max-h-32 shrink-0 overflow-auto border-b border-status-error-border bg-status-error px-3 py-2"
			role="region"
			aria-label={m.workflow_studio_diagnostics()}
		>
			<p class="text-sm font-medium text-status-error-foreground">
				{view !== 'source' && definition
					? m.workflow_studio_stale_graph()
					: m.workflow_studio_invalid_draft()}
			</p>
			<ul class="mt-1 space-y-1">
				{#each draft.result.diagnostics as issue, index (index)}
					<svelte:boundary>
						<li>
							<button
								class="block w-full wrap-anywhere text-left text-xs text-status-error-foreground underline focus-visible:outline-2 focus-visible:outline-ring"
								onclick={() => reveal(issue.range)}
							>
								{issue.range.start.line}:{issue.range.start.column}
								{issue.message}
							</button>
						</li>
						{#snippet failed()}<li class="text-xs">
								{m.workflow_studio_diagnostic_unavailable()}
							</li>{/snippet}
					</svelte:boundary>
				{/each}
			</ul>
		</div>
	{:else if draft.rejected}
		<div
			role="alert"
			class="max-h-32 shrink-0 overflow-auto border-b border-border px-3 py-2 text-sm text-destructive"
		>
			{#each draft.rejected.diagnostics as issue, index (index)}<p class="wrap-anywhere">
					{issue.message}
				</p>{/each}
			{#if draft.rejected.attemptedSource}
				<Button
					size="sm"
					variant="ghost"
					disabled={busy || Boolean(file?.comparison)}
					onclick={() => {
						const rejected = draft.rejected;
						if (!rejected?.attemptedSource || busy || file?.comparison) return;
						draft.replaceSource(rejected.attemptedSource);
						view = 'source';
						if (rejected.diagnostics[0]) reveal(rejected.diagnostics[0].range);
					}}>{m.workflow_studio_inspect_edit()}</Button
				>
			{/if}
		</div>
	{/if}

	{#if file?.comparison}
		{@const comparison = file.comparison}
		<div class="min-h-0 flex-1 overflow-auto p-3" {@attach nativeWorkspaceScrollRegion('primary')}>
			<FileConflictComparison
				baseContent={file.baseline}
				localContent={comparison.source}
				diskContent={comparison.disk}
				lineSeparator={(file.baseline.match(/\r\n|\r|\n/)?.[0] ?? '\n') === '\r\n' ? '\r\n' : '\n'}
				onCancel={() => (file.comparison = null)}
				onAcceptDisk={() => {
					const text = file.acceptDisk(draft.source);
					if (text !== undefined) draft.replaceSource(text);
				}}
				onSaveChecked={(content) =>
					void file.saveCompared(draft.source, content, (text) => draft.replaceSource(text))}
			/>
		</div>
	{:else if view === 'source'}
		{#await editor()}
			<p class="p-3 text-sm text-muted-foreground" role="status">
				{m.workflow_studio_loading_source()}
			</p>
		{:then SourceEditor}
			<SourceEditor
				source={draft.source}
				selection={location}
				readOnly={busy}
				onChange={(value) => {
					location = null;
					draft.replaceSource(value, true);
				}}
				onUndo={() => !busy && draft.undo()}
				onRedo={() => !busy && draft.redo()}
			/>
		{:catch}
			<p class="p-3 text-sm text-destructive" role="alert">{m.workflow_studio_source_failed()}</p>
		{/await}
	{:else}
		<WorkflowSplitView showingDetail={detailOpen}>
			{#snippet overview()}
				{#if view === 'graph'}
					{#await graph()}
						<p class="p-4 text-sm text-muted-foreground" role="status">
							{m.workflow_studio_loading_graph()}
						</p>
					{:then Graph}
						<Graph {steps} connections={edges} {selected} {focusRequest} onSelect={select} />
					{:catch}
						<p class="p-4 text-sm text-destructive" role="alert">
							{m.workflow_studio_graph_failed()}
						</p>
					{/await}
				{:else}
					{#if editable && current}
						<div class="space-y-2 border-b border-border px-3 pt-3">
							<form
								class="flex flex-wrap items-end gap-2"
								onsubmit={(event) => {
									event.preventDefault();
									if (editable && definitionName.trim())
										draft.edit([{ kind: 'upsert', path: ['name'], value: definitionName.trim() }]);
								}}
							>
								<label class="min-w-0 flex-1 space-y-1 text-sm">
									<span>{m.workflow_studio_definition_name()}</span>
									<input class="workflow-field" bind:value={definitionName} maxlength="256" />
								</label>
								<Button
									type="submit"
									variant="outline"
									size="sm"
									disabled={!definitionName.trim() || definitionName === current.name}
									>{m.workflow_studio_apply_name()}</Button
								>
							</form>
							<WorkflowInputsEditor
								bind:this={inputsRef}
								inputs={current.inputs}
								onPendingChange={(pending) => (pendingInputs = pending)}
								onChange={editInput}
							/>
						</div>
					{/if}
					<WorkflowStepList {steps} {edges} {selected} onSelect={select} />
				{/if}
			{/snippet}
			{#snippet inspector()}
				<div class="space-y-3 p-3 sm:p-4">
					<div class="flex flex-wrap items-center gap-1">
						<Button
							size="sm"
							variant="ghost"
							class="@min-[43rem]/workflow-split:hidden"
							onclick={back}
						>
							<ArrowLeft class="size-4" />
							{m.workflow_studio_back_to_steps()}
						</Button>
						<h2
							bind:this={heading}
							tabindex="-1"
							class="wrap-anywhere text-sm font-semibold outline-none"
						>
							{active?.name ?? active?.id ?? m.workflow_studio_step_details()}
						</h2>
					</div>
					{#if active && definition}
						<p class="wrap-anywhere text-xs text-muted-foreground">
							{workflowStepKindLabel(active.kind)} · {active.id}
						</p>
						{#key active.id}
							<WorkflowStepInspector
								bind:this={stepRef}
								step={active}
								{definition}
								{context}
								narrow={width < 688}
								editing={editable}
								onPendingChange={(pending) => (pendingStep = pending)}
								onEdit={(fields) => editStep(active.id, fields)}
								onDuplicate={() => runGuarded(() => duplicate(active))}
								onInsert={() =>
									runGuarded(() => {
										if (canAdd) picker = { after: active.id };
									})}
								onRemove={() => remove(active.id)}
								onBranch={(signal) =>
									runGuarded(() => {
										if (canAdd) picker = { signal, after: active.id };
									})}
							/>
						{/key}
					{:else}
						<p class="text-sm text-muted-foreground">{m.workflow_studio_select_step()}</p>
					{/if}
				</div>
			{/snippet}
		</WorkflowSplitView>
	{/if}
</section>

{#if picker}
	<WorkflowStepPicker
		insert={Boolean(picker.after)}
		onClose={() => (picker = null)}
		onPick={insert}
	/>
{/if}
{#if sharing}
	<WorkflowShareDialog
		source={draft.source}
		filename={`${
			(definition?.name ?? 'definition')
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, '-')
				.slice(0, 80) || 'definition'
		}.workflow.yaml`}
		onClose={() => (sharing = false)}
	/>
{/if}
{#if unappliedGuard}
	<Dialog.Root
		open
		onOpenChange={(open) => {
			if (!open) unappliedGuard = null;
		}}
	>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>{m.workflow_studio_unapplied_edits()}</Dialog.Title>
				<Dialog.Description>{m.workflow_studio_unapplied_warning()}</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onclick={() => (unappliedGuard = null)}
					>{m.workflow_studio_stay_fix()}</Button
				>
				<Button
					variant="destructive"
					onclick={() => {
						discardPending();
						const action = unappliedGuard;
						unappliedGuard = null;
						action?.();
					}}>{m.workflow_studio_discard_edits()}</Button
				>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
