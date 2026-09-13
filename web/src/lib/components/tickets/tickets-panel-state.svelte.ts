import { tick } from 'svelte';
import type { TicketSummary } from '$shared/tickets';
import type {
	TicketCloseConfirmation,
	TicketsController,
} from '$lib/tickets/catalog/tickets-controller.svelte.js';
import type { TicketDraftPartition } from '$lib/tickets/drafts/ticket-draft-recovery.js';
import type { TicketWindowKey } from '$lib/tickets/catalog/ticket-collection.js';
import type { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import {
	captureTicketFocus,
	ticketPanelMemory,
	restoreTicketFocus,
	type TicketFocusBookmark,
} from './ticket-panel-memory.svelte.js';

interface TicketsPanelDeps {
	readonly root: HTMLElement | null;
	readonly controller: TicketsController;
}

export class TicketsPanelState {
	readonly memory;
	#previousCollection: TicketsController['collection'] = null;

	constructor(private readonly deps: TicketsPanelDeps) {
		this.memory = ticketPanelMemory(deps.controller);
	}
	get pinned() {
		return this.memory.pinned;
	}
	set pinned(value: typeof this.memory.pinned) {
		this.memory.pinned = value;
	}

	preparePartition(partition: TicketDraftPartition | null): void {
		if (
			this.memory.partition?.storeId === partition?.storeId &&
			this.memory.partition?.viewerKey === partition?.viewerKey
		)
			return;
		this.memory.partition = partition;
		this.memory.pendingStatusMove = null;
		this.pinned = null;
		this.memory.focus = null;
		this.memory.returnTo = null;
		this.memory.returnIndex = 0;
		this.memory.restoreFocus = false;
		this.memory.scroll.clear();
		this.#previousCollection = null;
	}

	recordCloseConfirmation(confirmation: TicketCloseConfirmation): void {
		const focus = this.memory.focus?.target;
		if (
			focus?.kind === 'draft' &&
			focus.draftId === confirmation.draftId &&
			(document.activeElement === document.body ||
				document.activeElement?.closest(`[data-ticket-dialog-owner="${this.memory.id}"]`))
		) {
			this.memory.focus = this.memory.returnTo;
		}
		this.memory.pendingStatusMove = {
			ticketId: confirmation.ticketId,
			bookmark: this.memory.returnTo,
			fallbackIndex: this.memory.returnIndex,
			partition: confirmation,
		};
	}

	get items(): readonly TicketSummary[] {
		return Object.values(this.deps.controller.collection?.windows ?? {}).flatMap(
			(window) => window?.items ?? [],
		);
	}

	roots(): HTMLElement[] {
		return [
			...(this.deps.root ? [this.deps.root] : []),
			...document.querySelectorAll<HTMLElement>(`[data-ticket-dialog-owner="${this.memory.id}"]`),
		];
	}

	restore(bookmark = this.memory.focus, fallbackIndex = this.memory.returnIndex): void {
		restoreTicketFocus(this.roots(), bookmark, fallbackIndex);
		// Focus events precede selection restoration; subsequent host focus must retain the final selection.
		this.memory.focus = captureTicketFocus(document.activeElement) ?? this.memory.focus;
	}

	rememberInvoker(): void {
		this.memory.returnTo = captureTicketFocus(document.activeElement);
		const target = this.memory.returnTo?.target;
		this.memory.returnIndex = Math.max(
			0,
			this.items.findIndex((ticket) => target?.kind === 'ticket' && ticket.id === target.ticketId),
		);
	}

	retainsFocus(expected: TicketFocusBookmark | null): boolean {
		if (!this.deps.root?.isConnected || !this.memory.restoreFocus) return false;
		const focused = document.activeElement;
		const bookmark =
			captureTicketFocus(focused) ?? (focused === document.body ? this.memory.focus : null);
		if (!bookmark && focused !== document.body) return false;
		return JSON.stringify(bookmark?.target) === JSON.stringify(expected?.target);
	}

	async restoreInvoker(): Promise<void> {
		await tick();
		if (this.memory.restoreFocus && (document.activeElement === document.body || this.#ownsFocus()))
			this.restore(this.memory.returnTo);
	}

	#ownsFocus(): boolean {
		return this.roots().some((element) => element.contains(document.activeElement));
	}

	prepareCollectionChange(collection: TicketsController['collection']): void {
		const previous = this.#previousCollection;
		this.#previousCollection = collection;
		const root = this.deps.root;
		if (!root || !previous || !collection || previous === collection) return;
		const snapshots = [...root.querySelectorAll<HTMLElement>('[data-ticket-scroll]')].flatMap(
			(element) => {
				const key = element.dataset.ticketScroll as TicketWindowKey;
				if (!collection.windows[key] || !previous.windows[key]) return [];
				const reset =
					collection.counts.collectionRevision === previous.counts.collectionRevision &&
					collection.windows[key]!.pageIndex !== previous.windows[key]!.pageIndex;
				const top = element.getBoundingClientRect().top;
				const anchor = [...element.querySelectorAll<HTMLElement>('[data-ticket-id]')].find(
					(node) => node.getBoundingClientRect().bottom > top,
				);
				return [
					{
						key,
						reset,
						id: anchor?.dataset.ticketId,
						offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
					},
				];
			},
		);
		void tick().then(() => {
			if (
				!root.isConnected ||
				this.deps.root !== root ||
				this.deps.controller.collection !== collection
			)
				return;
			for (const snapshot of snapshots) {
				const element = [...root.querySelectorAll<HTMLElement>('[data-ticket-scroll]')].find(
					(node) => node.dataset.ticketScroll === snapshot.key,
				);
				if (!element) continue;
				const anchor = [...element.querySelectorAll<HTMLElement>('[data-ticket-id]')].find(
					(node) => node.dataset.ticketId === snapshot.id,
				);
				if (snapshot.reset) element.scrollTop = 0;
				else if (anchor)
					element.scrollTop +=
						anchor.getBoundingClientRect().top -
						element.getBoundingClientRect().top -
						snapshot.offset;
			}
		});
	}

	mount(frame: SurfaceFrameBridge): () => void {
		let generation = 0;
		const root = this.deps.root;
		const focused = (event: FocusEvent) => {
			if (!(event.target instanceof HTMLElement)) return;
			if (!this.#ownsFocus()) {
				if (event.target !== document.body) this.memory.restoreFocus = false;
				return;
			}
			this.memory.restoreFocus = true;
			const bookmark = captureTicketFocus(event.target);
			if (bookmark) this.memory.focus = bookmark;
			const key = event.target.closest<HTMLElement>('[data-ticket-window]')?.dataset.ticketWindow as
				TicketWindowKey | undefined;
			const target = bookmark?.target;
			const ticket =
				target?.kind === 'ticket' ? this.items.find((item) => item.id === target.ticketId) : null;
			this.pinned = key && ticket ? { key, ticket } : null;
		};
		const scroll = (event: Event) => {
			const element = event.target;
			if (!(element instanceof HTMLElement) || !element.dataset.ticketScroll) return;
			this.memory.scroll.set(element.dataset.ticketScroll, element.scrollTop);
			while (this.memory.scroll.size > 25)
				this.memory.scroll.delete(this.memory.scroll.keys().next().value!);
			const key = element.closest<HTMLElement>('[data-ticket-window]')?.dataset.ticketWindow as
				TicketWindowKey | undefined;
			const first = [...element.querySelectorAll<HTMLElement>('[data-ticket-id]')].find(
				(node) => node.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
			);
			const ticket = first && this.items.find((item) => item.id === first.dataset.ticketId);
			if (key && ticket) this.deps.controller.rememberAnchor(key, ticket.number);
		};
		const selectionChanged = () => {
			if (this.#ownsFocus())
				this.memory.focus = captureTicketFocus(document.activeElement) ?? this.memory.focus;
		};
		document.addEventListener('focusin', focused);
		document.addEventListener('selectionchange', selectionChanged);
		document.addEventListener('select', selectionChanged, true);
		root?.addEventListener('scroll', scroll, true);
		const release = frame.provideRenderer({
			attach: async () => {
				const token = ++generation;
				await tick();
				if (token !== generation) return;
				for (const element of root?.querySelectorAll<HTMLElement>('[data-ticket-scroll]') ?? [])
					element.scrollTop = this.memory.scroll.get(element.dataset.ticketScroll!) ?? 0;
				if (
					this.memory.restoreFocus &&
					(!document.activeElement || document.activeElement === document.body)
				)
					this.restore();
			},
			detach: () => {
				generation++;
				if (this.#ownsFocus())
					this.memory.focus = captureTicketFocus(document.activeElement) ?? this.memory.focus;
				this.deps.controller.drafts.flush();
			},
			focusPrimary: () => this.restore(),
		});
		return () => {
			generation++;
			release();
			document.removeEventListener('focusin', focused);
			document.removeEventListener('selectionchange', selectionChanged);
			document.removeEventListener('select', selectionChanged, true);
			root?.removeEventListener('scroll', scroll, true);
		};
	}
}
