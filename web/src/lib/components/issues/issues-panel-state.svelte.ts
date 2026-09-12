import { tick } from 'svelte';
import type { IssueSummary } from '$shared/issues';
import type {
	IssueCloseConfirmation,
	IssuesController,
} from '$lib/issues/catalog/issues-controller.svelte.js';
import type { IssueDraftPartition } from '$lib/issues/drafts/issue-draft-recovery.js';
import type { IssueWindowKey } from '$lib/issues/catalog/issue-collection.js';
import type { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import {
	captureIssueFocus,
	issuePanelMemory,
	restoreIssueFocus,
	type IssueFocusBookmark,
} from './issue-panel-memory.svelte.js';

interface IssuesPanelDeps {
	readonly root: HTMLElement | null;
	readonly controller: IssuesController;
}

export class IssuesPanelState {
	readonly memory;
	#previousCollection: IssuesController['collection'] = null;

	constructor(private readonly deps: IssuesPanelDeps) {
		this.memory = issuePanelMemory(deps.controller);
	}
	get pinned() {
		return this.memory.pinned;
	}
	set pinned(value: typeof this.memory.pinned) {
		this.memory.pinned = value;
	}

	preparePartition(partition: IssueDraftPartition | null): void {
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

	recordCloseConfirmation(confirmation: IssueCloseConfirmation): void {
		const focus = this.memory.focus?.target;
		if (
			focus?.kind === 'draft' &&
			focus.draftId === confirmation.draftId &&
			(document.activeElement === document.body ||
				document.activeElement?.closest(`[data-issue-dialog-owner="${this.memory.id}"]`))
		) {
			this.memory.focus = this.memory.returnTo;
		}
		this.memory.pendingStatusMove = {
			issueId: confirmation.issueId,
			bookmark: this.memory.returnTo,
			fallbackIndex: this.memory.returnIndex,
			partition: confirmation,
		};
	}

	get items(): readonly IssueSummary[] {
		return Object.values(this.deps.controller.collection?.windows ?? {}).flatMap(
			(window) => window?.items ?? [],
		);
	}

	roots(): HTMLElement[] {
		return [
			...(this.deps.root ? [this.deps.root] : []),
			...document.querySelectorAll<HTMLElement>(`[data-issue-dialog-owner="${this.memory.id}"]`),
		];
	}

	restore(bookmark = this.memory.focus, fallbackIndex = this.memory.returnIndex): void {
		restoreIssueFocus(this.roots(), bookmark, fallbackIndex);
		// Focus events precede selection restoration; subsequent host focus must retain the final selection.
		this.memory.focus = captureIssueFocus(document.activeElement) ?? this.memory.focus;
	}

	rememberInvoker(): void {
		this.memory.returnTo = captureIssueFocus(document.activeElement);
		const target = this.memory.returnTo?.target;
		this.memory.returnIndex = Math.max(
			0,
			this.items.findIndex((issue) => target?.kind === 'issue' && issue.id === target.issueId),
		);
	}

	retainsFocus(expected: IssueFocusBookmark | null): boolean {
		if (!this.deps.root?.isConnected || !this.memory.restoreFocus) return false;
		const focused = document.activeElement;
		const bookmark =
			captureIssueFocus(focused) ?? (focused === document.body ? this.memory.focus : null);
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

	prepareCollectionChange(collection: IssuesController['collection']): void {
		const previous = this.#previousCollection;
		this.#previousCollection = collection;
		const root = this.deps.root;
		if (!root || !previous || !collection || previous === collection) return;
		const snapshots = [...root.querySelectorAll<HTMLElement>('[data-issue-scroll]')].flatMap(
			(element) => {
				const key = element.dataset.issueScroll as IssueWindowKey;
				if (!collection.windows[key] || !previous.windows[key]) return [];
				const reset =
					collection.counts.collectionRevision === previous.counts.collectionRevision &&
					collection.windows[key]!.pageIndex !== previous.windows[key]!.pageIndex;
				const top = element.getBoundingClientRect().top;
				const anchor = [...element.querySelectorAll<HTMLElement>('[data-issue-id]')].find(
					(node) => node.getBoundingClientRect().bottom > top,
				);
				return [
					{
						key,
						reset,
						id: anchor?.dataset.issueId,
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
				const element = [...root.querySelectorAll<HTMLElement>('[data-issue-scroll]')].find(
					(node) => node.dataset.issueScroll === snapshot.key,
				);
				if (!element) continue;
				const anchor = [...element.querySelectorAll<HTMLElement>('[data-issue-id]')].find(
					(node) => node.dataset.issueId === snapshot.id,
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
			const bookmark = captureIssueFocus(event.target);
			if (bookmark) this.memory.focus = bookmark;
			const key = event.target.closest<HTMLElement>('[data-issue-window]')?.dataset.issueWindow as
				IssueWindowKey | undefined;
			const target = bookmark?.target;
			const issue =
				target?.kind === 'issue' ? this.items.find((item) => item.id === target.issueId) : null;
			this.pinned = key && issue ? { key, issue } : null;
		};
		const scroll = (event: Event) => {
			const element = event.target;
			if (!(element instanceof HTMLElement) || !element.dataset.issueScroll) return;
			this.memory.scroll.set(element.dataset.issueScroll, element.scrollTop);
			while (this.memory.scroll.size > 25)
				this.memory.scroll.delete(this.memory.scroll.keys().next().value!);
			const key = element.closest<HTMLElement>('[data-issue-window]')?.dataset.issueWindow as
				IssueWindowKey | undefined;
			const first = [...element.querySelectorAll<HTMLElement>('[data-issue-id]')].find(
				(node) => node.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
			);
			const issue = first && this.items.find((item) => item.id === first.dataset.issueId);
			if (key && issue) this.deps.controller.rememberAnchor(key, issue.number);
		};
		const selectionChanged = () => {
			if (this.#ownsFocus())
				this.memory.focus = captureIssueFocus(document.activeElement) ?? this.memory.focus;
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
				for (const element of root?.querySelectorAll<HTMLElement>('[data-issue-scroll]') ?? [])
					element.scrollTop = this.memory.scroll.get(element.dataset.issueScroll!) ?? 0;
				if (
					this.memory.restoreFocus &&
					(!document.activeElement || document.activeElement === document.body)
				)
					this.restore();
			},
			detach: () => {
				generation++;
				if (this.#ownsFocus())
					this.memory.focus = captureIssueFocus(document.activeElement) ?? this.memory.focus;
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
