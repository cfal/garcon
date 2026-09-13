<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { IssueSource, IssueStatus, IssueSummary } from '$shared/issues';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import { issueStatusLabel } from './issue-presentation.js';
	import { captureIssueFocus, type IssueStatusMove } from './issue-panel-memory.svelte.js';
	import { IssuesPanelState } from './issues-panel-state.svelte.js';
	import IssuesToolbar from './IssuesToolbar.svelte';
	import IssueCollection from './IssueCollection.svelte';
	import IssueDetail from './IssueDetail.svelte';
	import IssueDetailHeader from './IssueDetailHeader.svelte';
	import IssueCreateDialog from './IssueCreateDialog.svelte';
	import IssueCloseDialog from './IssueCloseDialog.svelte';
	import IssueRecovery from './IssueRecovery.svelte';
	import IssueMutationErrors from './IssueMutationErrors.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import './issues.css';
	let {
		controller,
		visible,
		chats,
		username,
		directory,
		onOpenChat,
		onOpenSource,
		onClose,
		closeDisabled = false,
		pinnedProjectPaths = [],
	}: {
		controller: IssuesController;
		visible: boolean;
		chats: readonly IssueChatSummary[];
		username: string;
		directory: string | null;
		onOpenChat: (id: string) => void;
		onOpenSource: (source: IssueSource) => void;
		onClose?: () => void;
		closeDisabled?: boolean;
		pinnedProjectPaths?: string[];
	} = $props();
	const frame = getSurfaceFrameBridge();
	let root = $state<HTMLElement | null>(null);
	const panel = new IssuesPanelState({
		get root() {
			return root;
		},
		get controller() {
			return controller;
		},
	});
	const memory = panel.memory;
	let announcement = $state('');
	const hasDetail = $derived(controller.detail.selectedId !== null);
	const refreshError = $derived(
		controller.error ?? (controller.stale && !controller.loading ? m.issues_stale() : null),
	);
	const detailError = $derived(controller.detail.error ?? refreshError);
	const allItems = $derived(
		Object.values(controller.collection?.windows ?? {}).flatMap((window) => window?.items ?? []),
	);
	const createdOutside = $derived(
		controller.createdIssueId !== null &&
			controller.collection !== null &&
			!controller.stale &&
			!allItems.some((issue) => issue.id === controller.createdIssueId),
	);
	async function open(issue: IssueSummary) {
		panel.rememberInvoker();
		controller.select(issue.id);
		await controller.refresh();
		await tick();
		if (root && (root.clientWidth < 900 || controller.detailFullWidth))
			root.querySelector<HTMLElement>('.issue-detail-title')?.focus();
	}
	async function back() {
		controller.select(null);
		await tick();
		panel.restore(memory.returnTo);
	}
	async function status(
		issue: Pick<IssueSummary, 'id' | 'revision' | 'status'>,
		next: IssueStatus,
	) {
		if (issue.status === next || controller.mutations.busy(issue.id)) return;
		const partition = controller.bootstrap;
		if (!partition) return;
		if (next === 'closed') {
			panel.rememberInvoker();
			controller.closeDraft = controller.drafts.open('close', { issue }, { resolution: 'done' });
			return;
		}
		const bookmark = captureIssueFocus(document.activeElement);
		const previousLane = controller.activeLane;
		const query = controller.query;
		const layout = controller.layout;
		if (controller.layout === 'board' && controller.lanes.includes(next))
			controller.activeLane = next;
		const completion = {
			issueId: issue.id,
			bookmark,
			partition,
			fallbackIndex: Math.max(
				0,
				allItems.findIndex((item) => item.id === issue.id),
			),
		};
		const changed = await controller.mutate(
			issue,
			issue.status === 'closed'
				? { action: 'reopen', issueId: issue.id, expectedRevision: issue.revision }
				: {
						action: 'update',
						issueId: issue.id,
						expectedRevision: issue.revision,
						patch: { status: next },
					},
		);
		if (
			controller.bootstrap?.storeId !== partition.storeId ||
			controller.bootstrap.viewerKey !== partition.viewerKey
		)
			return;
		if (!changed) {
			if (
				layout === 'board' &&
				controller.layout === layout &&
				controller.query === query &&
				controller.activeLane === next
			) {
				controller.activeLane = previousLane;
				await tick();
				if (panel.retainsFocus(bookmark)) panel.restore(bookmark, completion.fallbackIndex);
			}
			return;
		}
		memory.pendingStatusMove = completion;
		void controller.refresh();
	}
	async function reconcileStatusMove(completion: IssueStatusMove) {
		const { issueId, bookmark, partition } = completion;
		const current = () =>
			root?.isConnected &&
			memory.pendingStatusMove === completion &&
			!controller.stale &&
			controller.bootstrap?.storeId === partition.storeId &&
			controller.bootstrap?.viewerKey === partition.viewerKey;
		if (!current()) return;
		if (panel.pinned?.issue.id === issueId) panel.pinned = null;
		await tick();
		if (!current()) return;
		const displayed = allItems.find((item) => item.id === issueId);
		announcement = displayed
			? m.issues_status_move({ id: issueId, status: issueStatusLabel(displayed.status) })
			: m.issues_left_filter();
		if (panel.retainsFocus(bookmark)) {
			if (displayed && controller.layout === 'board') {
				controller.activeLane = displayed.status;
				await tick();
			}
			if (current() && panel.retainsFocus(bookmark))
				panel.restore(bookmark, completion.fallbackIndex);
		}
		if (current()) memory.pendingStatusMove = null;
	}
	$effect.pre(() => {
		const partition = controller.bootstrap;
		const collection = controller.collection;
		const close = controller.closeConfirmation;
		untrack(() => {
			panel.preparePartition(partition);
			if (close) {
				panel.recordCloseConfirmation(close);
				controller.closeConfirmation = null;
			}
			panel.prepareCollectionChange(collection);
		});
	});
	$effect(() => {
		const completion = memory.pendingStatusMove;
		if (completion && controller.collection && !controller.stale)
			untrack(() => void reconcileStatusMove(completion));
	});
	onMount(() => panel.mount(frame));
</script>

<section
	bind:this={root}
	class="issues-surface"
	class:has-detail={hasDetail}
	class:detail-full={controller.detailFullWidth}
	aria-label={m.issues_title()}
	data-issues-panel={memory.id}
>
	<p class="sr-only" role="status">{announcement}</p>
	<div class="issues-body">
		<div class="issue-browser">
			<IssuesToolbar
				{controller}
				{chats}
				{username}
				{onClose}
				{closeDisabled}
				onCreate={() => {
					panel.rememberInvoker();
					void controller.beginCreate(directory);
				}}
			/>
			{#if !hasDetail && refreshError}<div class="issue-notice" role="status">
					{refreshError}
					<button type="button" class="issue-button" onclick={() => void controller.refresh()}
						>{m.issues_retry()}</button
					>
				</div>{/if}
			<IssueRecovery {controller} />
			{#if !hasDetail}<IssueMutationErrors drafts={controller.drafts.active} />{/if}
			{#if createdOutside}<div class="issue-notice" role="status">
					{m.issues_created_outside()}
					<button
						class="issue-text-button"
						onclick={() => controller.setQuery({ includeClosed: true })}>{m.issues_reveal()}</button
					>
				</div>{/if}
			<div class="issue-collection" aria-busy={controller.loading}>
				{#if controller.layout === 'list' && controller.collection && !controller.stale && allItems.length === 0}<div
						class="issue-empty"
					>
						<h3>
							{Object.values(controller.query).some(
								(value) => value !== false && value !== undefined,
							)
								? m.issues_empty_filter()
								: m.issues_empty()}
						</h3>
						<p>{m.issues_empty_hint()}</p>
					</div>{/if}
				<IssueCollection
					{controller}
					pinned={panel.pinned}
					onOpen={(issue) => void open(issue)}
					onStatus={(issue, next) => void status(issue, next)}
				/>
			</div>
		</div>
		{#if controller.detail.selectedId}
			{#if controller.detail.current}{#key controller.detail.selectedId}<IssueDetail
						{controller}
						detail={controller.detail.current}
						error={detailError}
						{chats}
						{username}
						{onOpenChat}
						{onOpenSource}
						{onClose}
						{closeDisabled}
						{visible}
						onBack={() => void back()}
						onStatus={(next) => {
							if (controller.detail.current) void status(controller.detail.current.issue, next);
						}}
					/>{/key}
			{:else}<div class="issue-detail issue-detail-placeholder">
					<IssueDetailHeader
						issueId={controller.detail.selectedId}
						onBack={() => void back()}
						{onClose}
						{closeDisabled}
					/>
					<IssueMutationErrors drafts={controller.drafts.active} />
					<div class="issue-detail-status" role="status">
						{#if detailError}
							<p>{detailError}</p>
							<button class="issue-button" onclick={() => void controller.refresh()}
								>{m.issues_retry()}</button
							>
						{:else}
							<LoaderCircle size={24} class="animate-spin" aria-hidden="true" />
							<span class="sr-only">{m.issues_detail_loading()}</span>
						{/if}
					</div>
				</div>{/if}
		{/if}
	</div>
	{#if visible}<IssueCreateDialog
			{controller}
			{chats}
			{username}
			{pinnedProjectPaths}
			ownerId={memory.id}
			onClose={() => void panel.restoreInvoker()}
		/>{/if}
	{#if controller.closeDraft && visible}<IssueCloseDialog
			draft={controller.closeDraft}
			ownerId={memory.id}
			onClose={() => {
				controller.closeDraft?.flush();
				controller.closeDraft = null;
				void panel.restoreInvoker();
			}}
		/>{/if}
</section>
