<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { TicketSource, TicketStatus, TicketSummary } from '$shared/tickets';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import type { TicketChatSummary } from './ticket-presentation.js';
	import { ticketStatusLabel } from './ticket-presentation.js';
	import { captureTicketFocus, type TicketStatusMove } from './ticket-panel-memory.svelte.js';
	import { TicketsPanelState } from './tickets-panel-state.svelte.js';
	import TicketsToolbar from './TicketsToolbar.svelte';
	import TicketCollection from './TicketCollection.svelte';
	import TicketDetail from './TicketDetail.svelte';
	import TicketDetailHeader from './TicketDetailHeader.svelte';
	import TicketCreateDialog from './TicketCreateDialog.svelte';
	import TicketCloseDialog from './TicketCloseDialog.svelte';
	import TicketRecovery from './TicketRecovery.svelte';
	import TicketMutationErrors from './TicketMutationErrors.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import './tickets.css';
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
		controller: TicketsController;
		visible: boolean;
		chats: readonly TicketChatSummary[];
		username: string;
		directory: string | null;
		onOpenChat: (id: string) => void;
		onOpenSource: (source: TicketSource) => void;
		onClose?: () => void;
		closeDisabled?: boolean;
		pinnedProjectPaths?: string[];
	} = $props();
	const frame = getSurfaceFrameBridge();
	let root = $state<HTMLElement | null>(null);
	const panel = new TicketsPanelState({
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
		controller.error ?? (controller.stale && !controller.loading ? m.tickets_stale() : null),
	);
	const detailError = $derived(controller.detail.error ?? refreshError);
	const allItems = $derived(
		Object.values(controller.collection?.windows ?? {}).flatMap((window) => window?.items ?? []),
	);
	const createdOutside = $derived(
		controller.createdTicketId !== null &&
			controller.collection !== null &&
			!controller.stale &&
			!allItems.some((ticket) => ticket.id === controller.createdTicketId),
	);
	async function open(ticket: TicketSummary) {
		panel.rememberInvoker();
		controller.select(ticket.id);
		await controller.refresh();
		await tick();
		if (root && (root.clientWidth < 900 || controller.detailFullWidth))
			root.querySelector<HTMLElement>('.ticket-detail-title')?.focus();
	}
	async function back() {
		controller.select(null);
		await tick();
		panel.restore(memory.returnTo);
	}
	async function status(
		ticket: Pick<TicketSummary, 'id' | 'revision' | 'status'>,
		next: TicketStatus,
	) {
		if (ticket.status === next || controller.mutations.busy(ticket.id)) return;
		const partition = controller.bootstrap;
		if (!partition) return;
		if (next === 'closed') {
			panel.rememberInvoker();
			controller.closeDraft = controller.drafts.open('close', { ticket }, { resolution: 'done' });
			return;
		}
		const bookmark = captureTicketFocus(document.activeElement);
		const previousLane = controller.activeLane;
		const query = controller.query;
		const layout = controller.layout;
		if (controller.layout === 'board' && controller.lanes.includes(next))
			controller.activeLane = next;
		const completion = {
			ticketId: ticket.id,
			bookmark,
			partition,
			fallbackIndex: Math.max(
				0,
				allItems.findIndex((item) => item.id === ticket.id),
			),
		};
		const changed = await controller.mutate(
			ticket,
			ticket.status === 'closed'
				? { action: 'reopen', ticketId: ticket.id, expectedRevision: ticket.revision }
				: {
						action: 'update',
						ticketId: ticket.id,
						expectedRevision: ticket.revision,
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
	async function reconcileStatusMove(completion: TicketStatusMove) {
		const { ticketId, bookmark, partition } = completion;
		const current = () =>
			root?.isConnected &&
			memory.pendingStatusMove === completion &&
			!controller.stale &&
			controller.bootstrap?.storeId === partition.storeId &&
			controller.bootstrap?.viewerKey === partition.viewerKey;
		if (!current()) return;
		if (panel.pinned?.ticket.id === ticketId) panel.pinned = null;
		await tick();
		if (!current()) return;
		const displayed = allItems.find((item) => item.id === ticketId);
		announcement = displayed
			? m.tickets_status_move({ id: ticketId, status: ticketStatusLabel(displayed.status) })
			: m.tickets_left_filter();
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
	class="tickets-surface"
	class:has-detail={hasDetail}
	class:detail-full={controller.detailFullWidth}
	aria-label={m.tickets_title()}
	data-tickets-panel={memory.id}
>
	<p class="sr-only" role="status">{announcement}</p>
	<div class="tickets-body">
		<div class="ticket-browser">
			<TicketsToolbar
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
			{#if !hasDetail && refreshError}<div class="ticket-notice" role="status">
					{refreshError}
					<button type="button" class="ticket-button" onclick={() => void controller.refresh()}
						>{m.tickets_retry()}</button
					>
				</div>{/if}
			<TicketRecovery {controller} />
			{#if !hasDetail}<TicketMutationErrors drafts={controller.drafts.active} />{/if}
			{#if createdOutside}<div class="ticket-notice" role="status">
					{m.tickets_created_outside()}
					<button
						class="ticket-text-button"
						onclick={() => controller.setQuery({ includeClosed: true })}>{m.tickets_reveal()}</button
					>
				</div>{/if}
			<div class="ticket-collection" aria-busy={controller.loading}>
				{#if controller.layout === 'list' && controller.collection && !controller.stale && allItems.length === 0}<div
						class="ticket-empty"
					>
						<h3>
							{Object.values(controller.query).some(
								(value) => value !== false && value !== undefined,
							)
								? m.tickets_empty_filter()
								: m.tickets_empty()}
						</h3>
						<p>{m.tickets_empty_hint()}</p>
					</div>{/if}
				<TicketCollection
					{controller}
					pinned={panel.pinned}
					onOpen={(ticket) => void open(ticket)}
					onStatus={(ticket, next) => void status(ticket, next)}
				/>
			</div>
		</div>
		{#if controller.detail.selectedId}
			{#if controller.detail.current}{#key controller.detail.selectedId}<TicketDetail
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
							if (controller.detail.current) void status(controller.detail.current.ticket, next);
						}}
					/>{/key}
			{:else}<div class="ticket-detail ticket-detail-placeholder">
					<TicketDetailHeader onBack={() => void back()} {onClose} {closeDisabled} />
					<TicketMutationErrors drafts={controller.drafts.active} />
					<div class="ticket-detail-status" role="status">
						{#if detailError}
							<p>{detailError}</p>
							<button class="ticket-button" onclick={() => void controller.refresh()}
								>{m.tickets_retry()}</button
							>
						{:else}
							<LoaderCircle size={24} class="animate-spin" aria-hidden="true" />
							<span class="sr-only">{m.tickets_detail_loading()}</span>
						{/if}
					</div>
				</div>{/if}
		{/if}
	</div>
	{#if visible}<TicketCreateDialog
			{controller}
			{chats}
			{username}
			{pinnedProjectPaths}
			ownerId={memory.id}
			onClose={() => void panel.restoreInvoker()}
		/>{/if}
	{#if controller.closeDraft && visible}<TicketCloseDialog
			draft={controller.closeDraft}
			ownerId={memory.id}
			onClose={() => {
				controller.closeDraft?.flush();
				controller.closeDraft = null;
				void panel.restoreInvoker();
			}}
		/>{/if}
</section>
