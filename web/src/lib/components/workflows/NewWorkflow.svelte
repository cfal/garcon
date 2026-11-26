<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import FileUp from '@lucide/svelte/icons/file-up';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		deleteWorkflowDefinition,
		getWorkflowRevision,
		listWorkflowDefinitionsPage,
		listWorkflowRevisions,
		listWorkflowRunsPage,
	} from '$lib/api/workflows';
	import type { JsonObject } from '$shared/json';
	import type {
		WorkflowDefinitionSummary,
		WorkflowExecutionContext,
		WorkflowRevision,
		WorkflowRevisionSummary,
		WorkflowRunSummary,
	} from '$shared/workflow-runs';
	import { WorkflowDraftState } from '$lib/workflows/definition/workflow-draft-state.svelte';
	import {
		getWorkflowStudioSession,
		type StudioLaunchSeed,
	} from '$lib/workflows/definition/workflow-studio-session.svelte';
	import { WORKFLOW_STARTER_TEMPLATES } from '$lib/workflows/definition/workflow-templates';
	import type { WorkflowFileState } from '$lib/workflows/definition/workflow-file-state.svelte';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region';
	import { createRandomId } from '$lib/utils/random-id';
	import * as m from '$lib/paraglide/messages.js';
	import WorkflowDefinitionEditor from './WorkflowDefinitionEditor.svelte';
	import WorkflowLaunchForm from './WorkflowLaunchForm.svelte';
	import WorkflowSourcePicker from './WorkflowSourcePicker.svelte';
	import { workflowStatusLabel } from './workflow-labels';
	import './workflow-form.css';

	let {
		context,
		onRunStarted,
		onOpenRun,
	}: {
		context: WorkflowLaunchContext | null;
		onRunStarted: (runId: string) => void;
		onOpenRun: (runId: string) => void;
	} = $props();

	type Page = 'launch' | 'editor' | 'test';
	type SourceMode = 'open' | 'import' | 'paste';
	const session = getWorkflowStudioSession();
	const retained = untrack(() => session.current);
	const draftContext = $derived(session.current ? session.current.context : context);
	let page = $state<Page>(retained ? 'editor' : 'launch');
	let definitions = $state.raw<readonly WorkflowDefinitionSummary[]>([]);
	let cursor = $state<string | null>(null);
	let recentRuns = $state.raw<readonly WorkflowRunSummary[]>([]);
	let chosen = $state('');
	let revision = $state.raw<WorkflowRevision | null>(null);
	let revisions = $state.raw<readonly WorkflowRevisionSummary[]>([]);
	let launchSeed = $state.raw<StudioLaunchSeed | null>(null);
	let draft = $derived(session.current?.draft ?? null);
	let testSource = $state('');
	let chooser = $state<SourceMode | null>(null);
	let templatePickerOpen = $state(false);
	let replace = $state.raw<(() => void) | null>(null);
	let unappliedGuard = $state.raw<(() => void) | null>(null);
	let editorRef = $state<{
		flushPending(): 'clean' | 'applied' | 'blocked';
		discardPending(): void;
	}>();
	let deleteOpen = $state(false);
	let deleting = $state(false);
	let loadError = $state<string | null>(null);
	let revisionError = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	let recentError = $state<string | null>(null);
	let loading = $state(false);
	let loadingRevision = $state(false);
	let lifetime: AbortController | null = null;
	let revisionRead: AbortController | null = null;
	let recentRead = 0;
	const locked = $derived(session.locked || deleting);
	const latestSummary = $derived(
		revision?.definitionId ? definitions.find((entry) => entry.id === revision?.definitionId) : null,
	);
	const deleteRevision = $derived(
		latestSummary?.revision ?? revisions[0]?.revision ?? revision?.revision ?? null,
	);
	const id = $props.id();

	$effect(() => {
		const req = session.navigationRequest;
		if (!req) return;
		untrack(() => {
			session.consumeNavigationRequest(req.id);
			if (req.kind === 'editor') {
				if (
					session.current?.draft.source === req.revision.source &&
					!session.current.draft.dirty &&
					!session.pendingEdits
				) {
					page = 'editor';
					return;
				}
				changeDraft(() =>
					installDraft(
						new WorkflowDraftState(req.revision.source, { definition: req.revision }),
						req.context,
					),
				);
				return;
			}
			const run = req.run;
			launchSeed = {
				key: `${run.id}:${req.id}`,
				inputs: run.inputs,
				executionContext: run.executionContext,
			};
			if (run.definitionId !== null && run.revision !== null) {
				const defId = run.definitionId;
				const revNum = run.revision;
				revisionRead?.abort();
				revisionRead = null;
				loadingRevision = false;
				revisionError = null;
				deleteError = null;
				chosen = `${defId}:${revNum}`;
				revision = run.pinnedRevision;
				revisions = [];
				page = 'launch';
				void listWorkflowRevisions(defId, { signal: lifetime?.signal })
					.then((listed) => {
						if (revision?.definitionId === defId) revisions = listed.items;
					})
					.catch(() => {});
			} else {
				const target = run.executionContext.defaultTarget;
				const runContext = target ? { executorId: target.executorId, cwd: target.projectPath } : null;
				changeDraft(() => {
					installDraft(new WorkflowDraftState(run.pinnedRevision.source), runContext);
					testSource = run.pinnedRevision.source;
					page = 'test';
				});
			}
		});
	});

	onMount(() => {
		lifetime = new AbortController();
		const detach = session.observe({
			launched(id) {
				onRunStarted(id);
				void loadRuns();
			},
			published(published) {
				void loadDefinitions();
				if (published?.definitionId && published.revision !== null) {
					const defId = published.definitionId;
					const revNum = published.revision;
					revisionRead?.abort();
					revisionRead = null;
					loadingRevision = false;
					revisionError = null;
					deleteError = null;
					chosen = `${defId}:${revNum}`;
					revision = published;
					revisions = [];
					launchSeed = null;
					void listWorkflowRevisions(defId, { signal: lifetime?.signal })
						.then((listed) => {
							if (revision?.definitionId === defId && revision.revision === revNum) {
								revisions = listed.items;
							}
						})
						.catch(() => {});
				}
			},
		});
		void loadDefinitions();
		void loadRuns();
		return () => {
			detach();
			lifetime?.abort();
			lifetime = null;
			revisionRead?.abort();
		};
	});

	function failure(error: unknown): string {
		return error instanceof Error ? error.message : m.workflow_studio_action_failed();
	}

	async function loadDefinitions(more = false) {
		if (loading || !lifetime || (more && !cursor)) return;
		const { signal } = lifetime;
		loading = true;
		loadError = null;
		try {
			const result = await listWorkflowDefinitionsPage({
				signal,
				limit: 50,
				cursor: more ? (cursor ?? undefined) : undefined,
			});
			if (signal.aborted) return;
			definitions = more
				? [...new Map([...definitions, ...result.items].map((entry) => [entry.id, entry])).values()]
				: result.items;
			cursor = result.nextCursor;
		} catch (error) {
			if (!signal.aborted) loadError = failure(error);
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	async function loadRuns() {
		if (!lifetime) return;
		const { signal } = lifetime;
		const read = ++recentRead;
		try {
			const page = await listWorkflowRunsPage({ signal, limit: 10 });
			if (signal.aborted || read !== recentRead) return;
			recentRuns = page.items;
			recentError = null;
		} catch (error) {
			if (!signal.aborted && read === recentRead) recentError = failure(error);
		}
	}

	const optionKey = (entry: WorkflowDefinitionSummary) => `${entry.id}:${entry.revision}`;

	async function select(key: string) {
		if (locked) return;
		const summary = definitions.find((entry) => optionKey(entry) === key);
		const separator = key.lastIndexOf(':');
		const definitionId = summary?.id ?? (separator > 0 ? key.slice(0, separator) : '');
		const targetRevision =
			summary?.revision ?? (separator > 0 ? Number(key.slice(separator + 1)) : Number.NaN);
		chosen = key;
		launchSeed = null;
		revisionRead?.abort();
		revision = null;
		revisions = [];
		revisionError = null;
		deleteError = null;
		loadingRevision = false;
		if (!definitionId || !Number.isSafeInteger(targetRevision) || targetRevision < 1) return;
		const read = new AbortController();
		revisionRead = read;
		loadingRevision = true;
		try {
			const [result, history] = await Promise.all([
				getWorkflowRevision(definitionId, targetRevision, { signal: read.signal }),
				listWorkflowRevisions(definitionId, { signal: read.signal }).catch(() => null),
			]);
			if (!read.signal.aborted && revisionRead === read) {
				revision = result;
				revisions = history?.items ?? [];
			}
		} catch (error) {
			if (!read.signal.aborted) revisionError = failure(error);
		} finally {
			if (revisionRead === read) {
				revisionRead = null;
				loadingRevision = false;
			}
		}
	}

	async function deleteSelectedDefinition() {
		const definitionId = revision?.definitionId;
		if (!definitionId || deleteRevision === null || deleting || locked) return;
		deleting = true;
		deleteError = null;
		deleteOpen = false;
		try {
			await deleteWorkflowDefinition({ definitionId, expectedRevision: deleteRevision });
			if (revision?.definitionId === definitionId) {
				chosen = '';
				revision = null;
				revisions = [];
				launchSeed = null;
			}
			await loadDefinitions();
		} catch (error) {
			deleteError = failure(error);
		} finally {
			deleting = false;
		}
	}

	function installDraft(next: WorkflowDraftState, draftContext: WorkflowLaunchContext | null = context) {
		session.replace(next, draftContext);
		chooser = null;
		page = 'editor';
	}

	function blankDraft() {
		const name = JSON.stringify(m.workflow_studio_untitled());
		const prompt = JSON.stringify(m.workflow_studio_new_decision_prompt());
		const approve = JSON.stringify(m.workflow_studio_approve());
		const reject = JSON.stringify(m.workflow_studio_reject());
		const source = `version: 1\nname: ${name}\nsteps:\n  - id: review\n    kind: decision\n    prompt: ${prompt}\n    choices:\n      approve: ${approve}\n      reject: ${reject}\n`;
		return new WorkflowDraftState(source, { baseline: source });
	}

	function runEditorTransition(action: () => void) {
		if (page === 'editor' && editorRef?.flushPending() === 'blocked') {
			unappliedGuard = action;
			return;
		}
		action();
	}

	function changeDraft(action: () => void) {
		if (locked || draft?.file?.busy) return;
		runEditorTransition(() => {
			if (draft?.dirty) replace = action;
			else action();
		});
	}

	function openEditor() {
		if (!draft) installDraft(blankDraft());
		else page = 'editor';
	}

	function editPublished() {
		const selected = revision;
		if (selected)
			changeDraft(() =>
				installDraft(new WorkflowDraftState(selected.source, { definition: selected })),
			);
	}

	async function launch(inputs: JsonObject, executionContext: WorkflowExecutionContext) {
		if (locked) return;
		const operationId = createRandomId();
		const launch = { operationId, inputs, executionContext };
		if (page === 'test' && draft?.result.definition && draft.source === testSource) {
			const request = { ...launch, source: testSource };
			await session.launch(request);
		} else if (page === 'launch' && revision?.definitionId && revision.revision !== null) {
			const request = {
				...launch,
				definitionId: revision.definitionId,
				revision: revision.revision,
			};
			await session.launch(request);
		}
	}
</script>

<section class="flex h-full min-h-0 min-w-0 flex-col" aria-label={m.workflow_studio_new_workflow()}>
	<header class="shrink-0 space-y-1.5 border-b border-border bg-card px-3 py-1.5 sm:px-4">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h1 class="text-base font-semibold">{m.workflow_studio_new_workflow()}</h1>
			<div class="flex flex-wrap gap-1">
				<Button
					size="sm"
					variant={page === 'launch' ? 'secondary' : 'ghost'}
					aria-pressed={page === 'launch'}
					disabled={locked}
					onclick={() => runEditorTransition(() => (page = 'launch'))}
					>{m.workflow_studio_new_run()}</Button
				>
				<Button
					size="sm"
					variant={page !== 'launch' ? 'secondary' : 'ghost'}
					aria-pressed={page !== 'launch'}
					disabled={locked}
					onclick={openEditor}>{m.workflow_studio_editor()}</Button
				>
			</div>
		</div>
		{#if page === 'editor'}
			<div class="flex flex-wrap gap-1">
				<Button
					size="sm"
					variant="ghost"
					disabled={locked}
					onclick={() => changeDraft(() => installDraft(blankDraft()))}
					><Plus class="size-4" /> {m.workflow_studio_new_definition()}</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={locked}
					onclick={() => changeDraft(() => (chooser = 'open'))}
					><FolderOpen class="size-4" /> {m.workflow_studio_open_file()}</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={locked}
					onclick={() => changeDraft(() => (chooser = 'import'))}
					><FileUp class="size-4" /> {m.workflow_studio_import_file()}</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={locked}
					onclick={() => changeDraft(() => (chooser = 'paste'))}>{m.workflow_studio_paste()}</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={locked}
					onclick={() => (templatePickerOpen = true)}
					><Sparkles class="size-4" /> {m.workflow_studio_templates()}</Button
				>
			</div>
		{/if}
	</header>
	{#if session.startedRun}
		{@const run = session.startedRun}
		<div role="status" class="shrink-0 border-b border-border px-3 py-1">
			<Button
				variant="link"
				size="sm"
				class="h-auto max-w-full justify-start whitespace-normal wrap-anywhere text-start"
				onclick={() => onOpenRun(run.id)}
				>{m.workflow_studio_open_started_run({ name: run.name })}</Button
			>
		</div>
	{/if}
	{#if session.error}
		<div class="shrink-0 space-y-1 border-b border-border px-3 py-2">
			<p role="alert" class="wrap-anywhere text-sm text-destructive">{session.error}</p>
			{#if session.pendingLaunch}
				{@const action = session.pendingLaunch}
				<Button
					size="sm"
					variant="outline"
					disabled={session.busy}
					onclick={() => void session.launch(action)}>{m.workflow_studio_retry_launch()}</Button
				>
			{:else if session.pendingPublish}
				<Button
					size="sm"
					variant="outline"
					disabled={session.busy}
					onclick={() => void session.checkPublish()}>{m.workflow_studio_check_published()}</Button
				>
			{/if}
		</div>
	{/if}
	{#if session.notice}
		<div
			role="status"
			class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-sm text-status-success-foreground"
		>
			<span>{session.notice}</span>
			{#if session.publishedRevision && page === 'editor'}
				<Button
					size="sm"
					variant="outline"
					disabled={locked}
					onclick={() => runEditorTransition(() => (page = 'launch'))}
					>{m.workflow_studio_run_now()}</Button
				>
			{/if}
		</div>
	{/if}

	{#if page === 'editor' && draft}
		{#key draft}
			<WorkflowDefinitionEditor
				bind:this={editorRef}
				{draft}
				context={draftContext}
				busy={locked}
				onPendingChange={(pending) => (session.pendingEdits = pending)}
				onPublish={() => draft && void session.publish(draft)}
				onTest={() => {
					if (!draft?.result.definition || locked) return;
					testSource = draft.source;
					page = 'test';
				}}
			/>
		{/key}
	{:else if page === 'test' && draft?.result.definition}
		<div
			class="min-h-0 flex-1 overflow-auto p-3 sm:p-4"
			{@attach nativeWorkspaceScrollRegion('primary')}
		>
			<div class="mx-auto max-w-2xl space-y-3">
				<Button variant="ghost" size="sm" disabled={locked} onclick={openEditor}
					><ArrowLeft class="size-4" /> {m.workflow_studio_back_to_editor()}</Button
				>
				<h2 class="text-base font-semibold">{m.workflow_studio_test_run()}</h2>
				<p class="wrap-anywhere text-sm text-muted-foreground">
					{m.workflow_studio_test_independent()}
				</p>
				{#key launchSeed?.key ?? ''}
					<WorkflowLaunchForm
						definition={draft.result.definition}
						context={draftContext}
						initialValues={launchSeed}
						draftRun
						disabled={locked}
						onLaunch={launch}
					/>
				{/key}
			</div>
		</div>
	{:else}
		<div
			class="@container/workflow-launch min-h-0 flex-1 overflow-auto p-3 sm:p-4"
			{@attach nativeWorkspaceScrollRegion('primary')}
		>
			<div
				class="mx-auto grid max-w-5xl gap-6 @min-[43rem]/workflow-launch:grid-cols-[minmax(0,1fr)_minmax(15rem,28%)]"
			>
				<div class="min-w-0 space-y-4">
					<div class="space-y-2">
						<label for={`${id}-definition`} class="block text-sm font-semibold"
							>{m.workflow_studio_definition()}</label
						>
						<div class="flex items-center gap-1">
							<select
								id={`${id}-definition`}
								class="workflow-field flex-1 text-base"
								value={chosen}
								disabled={locked}
								onchange={(event) => void select(event.currentTarget.value)}
							>
								<option value="">{m.workflow_studio_choose_definition()}</option>
								{#if revision && !definitions.some((entry) => optionKey(entry) === chosen)}
									<option value={chosen}
										>{revision.definition.name} · {m.workflow_studio_revision({
											revision: revision.revision ?? '',
										})}</option
									>
								{/if}
								{#each definitions as entry (entry.id)}
									<option value={optionKey(entry)}
										>{entry.name} · {m.workflow_studio_revision({
											revision: entry.revision,
										})}</option
									>
								{/each}
							</select>
							<Button
								variant="ghost"
								size="icon-sm"
								title={m.workflow_studio_refresh()}
								aria-label={m.workflow_studio_refresh()}
								disabled={loading}
								onclick={() => {
									void loadDefinitions();
									void loadRuns();
								}}><RefreshCw class="size-4" /></Button
							>
						</div>
						{#if cursor}<Button
								size="sm"
								variant="ghost"
								disabled={loading}
								onclick={() => void loadDefinitions(true)}
								>{m.workflow_studio_more_definitions()}</Button
							>{/if}
						{#if loadError || revisionError}<p
								role="alert"
								class="wrap-anywhere text-sm text-destructive"
							>
								{loadError ?? revisionError}
							</p>{/if}
						{#if loading || loadingRevision}<p role="status" class="text-sm text-muted-foreground">
								{m.workflow_studio_loading_definitions()}
							</p>{/if}
						{#if !loading && !loadError && !definitions.length}
							<div class="space-y-2 rounded-md border border-dashed border-border p-3">
								<p class="text-sm text-muted-foreground">
									{m.workflow_studio_no_definitions()}
								</p>
								<p class="text-xs text-muted-foreground">
									{m.workflow_studio_templates_description()}
								</p>
								<div class="flex flex-wrap gap-2">
									{#each WORKFLOW_STARTER_TEMPLATES as template (template.id)}
										<Button
											size="sm"
											variant="outline"
											disabled={locked}
											onclick={() =>
												changeDraft(() =>
													installDraft(
														new WorkflowDraftState(template.source, {
															baseline: template.source,
														}),
													),
												)}>{template.title}</Button
										>
									{/each}
								</div>
							</div>
						{/if}
					</div>
					{#if revision}
						{#if revisions.length && revision.definitionId}
							{@const defId = revision.definitionId}
							<div class="space-y-1">
								<label for={`${id}-revision`} class="block text-sm font-medium"
									>{m.workflow_studio_revision_history()}</label
								>
								<select
									id={`${id}-revision`}
									class="workflow-field text-base"
									value={String(revision.revision ?? '')}
									disabled={locked}
									onchange={(event) => void select(`${defId}:${event.currentTarget.value}`)}
								>
									{#each revisions as entry, index (entry.revision)}
										<option value={String(entry.revision)}
											>{index === 0
												? m.workflow_studio_revision_latest({ revision: entry.revision })
												: m.workflow_studio_revision({ revision: entry.revision })}</option
										>
									{/each}
								</select>
							</div>
						{/if}
						{#if revision.definition.description}<p
								class="wrap-anywhere text-sm text-muted-foreground"
							>
								{revision.definition.description}
							</p>{/if}
						<div class="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="outline" disabled={locked} onclick={editPublished}
								>{m.workflow_studio_edit_definition()}</Button
							>
							{#if revision.definitionId && deleteRevision !== null}
								<Button
									size="sm"
									variant="ghost"
									class="text-destructive"
									disabled={locked}
									onclick={() => (deleteOpen = true)}
									><Trash2 class="size-4" /> {m.workflow_studio_delete_definition()}</Button
								>
							{/if}
						</div>
						{#if deleteError}
							<p role="alert" class="wrap-anywhere text-sm text-destructive">{deleteError}</p>
						{/if}
						{#key `${revision.definitionId}:${revision.revision}:${launchSeed?.key ?? ''}`}
							<WorkflowLaunchForm
								definition={revision.definition}
								{context}
								initialValues={launchSeed}
								draftRun={false}
								disabled={locked}
								onLaunch={launch}
							/>
						{/key}
					{/if}
				</div>
				<div class="min-w-0 space-y-2">
					<h2 class="text-sm font-semibold">{m.workflow_studio_recent_runs()}</h2>
					{#if recentError}
						<p class="wrap-anywhere text-sm text-destructive">{recentError}</p>
					{:else}
						<ul class="divide-y divide-border border-y border-border">
							{#each recentRuns as run (run.id)}
								<svelte:boundary>
									<li>
										<button
											class="block w-full px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
											type="button"
											onclick={() => onOpenRun(run.id)}
										>
											<span class="block wrap-anywhere text-sm font-medium">{run.name}</span>
											<span class="block text-xs text-muted-foreground"
												>{workflowStatusLabel(run.status)}</span
											>
										</button>
									</li>
									{#snippet failed()}<li class="p-2 text-sm text-destructive">
											{m.workflow_studio_read_failed()}
										</li>{/snippet}
								</svelte:boundary>
							{:else}<li class="p-2 text-sm text-muted-foreground">
									{m.workflow_studio_no_runs()}
								</li>{/each}
						</ul>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</section>

{#if chooser}
	{#key chooser}
		<WorkflowSourcePicker
			mode={chooser}
			{context}
			onOpen={(file: WorkflowFileState) =>
				installDraft(new WorkflowDraftState(file.baseline, { file }))}
			onImport={(source) => installDraft(new WorkflowDraftState(source))}
			onClose={() => (chooser = null)}
		/>
	{/key}
{/if}
{#if deleteOpen && revision && deleteRevision !== null}
	<Dialog.Root
		open
		onOpenChange={(open) => {
			if (!open) deleteOpen = false;
		}}
	>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>{m.workflow_studio_delete_definition()}</Dialog.Title>
				<Dialog.Description
					>{m.workflow_studio_delete_confirm({
						name: revision.definition.name,
						revision: deleteRevision,
					})}</Dialog.Description
				>
			</Dialog.Header>
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onclick={() => (deleteOpen = false)}>{m.common_cancel()}</Button>
				<Button variant="destructive" disabled={locked} onclick={deleteSelectedDefinition}
					>{m.workflow_studio_delete_definition()}</Button
				>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
{#if replace}
	<Dialog.Root
		open
		onOpenChange={(open) => {
			if (!open) replace = null;
		}}
	>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>{m.workflow_studio_replace_draft()}</Dialog.Title>
				<Dialog.Description>{m.workflow_studio_replace_warning()}</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onclick={() => (replace = null)}>{m.common_cancel()}</Button>
				<Button
					variant="outline"
					onclick={() => {
						const action = replace;
						replace = null;
						action?.();
					}}>{m.workflow_studio_continue()}</Button
				>
			</div>
		</Dialog.Content>
	</Dialog.Root>
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
						editorRef?.discardPending();
						const action = unappliedGuard;
						unappliedGuard = null;
						action?.();
					}}>{m.workflow_studio_discard_edits()}</Button
				>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
{#if templatePickerOpen}
	<Dialog.Root
		open
		onOpenChange={(open) => {
			if (!open) templatePickerOpen = false;
		}}
	>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>{m.workflow_studio_templates()}</Dialog.Title>
				<Dialog.Description>{m.workflow_studio_templates_description()}</Dialog.Description>
			</Dialog.Header>
			<div class="space-y-2">
				{#each WORKFLOW_STARTER_TEMPLATES as template (template.id)}
					<div class="flex items-start justify-between gap-3 rounded-md border border-border p-3">
						<div class="min-w-0 space-y-1">
							<p class="text-sm font-medium">{template.title}</p>
							<p class="wrap-anywhere text-xs text-muted-foreground">{template.summary}</p>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={locked}
							onclick={() => {
								templatePickerOpen = false;
								changeDraft(() =>
									installDraft(
										new WorkflowDraftState(template.source, {
											baseline: template.source,
										}),
									),
								);
							}}>{m.workflow_studio_use_template()}</Button
						>
					</div>
				{/each}
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
