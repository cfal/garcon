import { SvelteSet } from 'svelte/reactivity';
import type {
	WorkflowActiveChat,
	WorkflowPage,
	WorkflowPageRequest,
	WorkflowRunSummary,
} from '$shared/workflow-runs';
import type { SidebarWorkflowPageKind, SidebarWorkflowRun } from './sidebar-virtual-chat-list';

const RUN_PAGE_SIZE = 20;
const ACTIVE_CHAT_PAGE_SIZE = 100;
const ACTIVE_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 30_000;

type PageReader<T> = (
	options: WorkflowPageRequest & { signal: AbortSignal },
) => Promise<WorkflowPage<T>>;

function sameRun(a: SidebarWorkflowRun, b: SidebarWorkflowRun): boolean {
	return a.id === b.id && a.name === b.name && a.status === b.status;
}

function samePage<T>(
	a: WorkflowPage<T> | null,
	b: WorkflowPage<T>,
	equal: (a: T, b: T) => boolean,
): boolean {
	return (
		a !== null &&
		a.nextCursor === b.nextCursor &&
		a.items.length === b.items.length &&
		a.items.every((item, index) => equal(item, b.items[index]))
	);
}

function runFromMembership(chat: WorkflowActiveChat): SidebarWorkflowRun {
	return { id: chat.runId, name: chat.runName, status: chat.runStatus };
}

export class SidebarWorkflowIndex {
	#recentRuns = $state.raw<WorkflowPage<WorkflowRunSummary> | null>(null);
	#olderRuns = $state.raw<WorkflowPage<WorkflowRunSummary> | null>(null);
	#activeChats = $state.raw<WorkflowPage<WorkflowActiveChat> | null>(null);
	#selected = $state.raw<{ chatId: string; run: SidebarWorkflowRun } | null>(null);
	#selectedChatId: string | null = null;
	#activePageCount = 1;
	#live = false;
	#refreshPending = false;
	#request: AbortController | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#activeByChat = $derived(new Map(this.#activeChats?.items.map((chat) => [chat.chatId, chat])));
	#runsById = $derived.by(() => {
		const runs = new Map<string, SidebarWorkflowRun>();
		for (const run of this.#recentRuns?.items ?? []) runs.set(run.id, run);
		for (const chat of this.#activeByChat.values()) {
			if (!runs.has(chat.runId)) runs.set(chat.runId, runFromMembership(chat));
		}
		for (const run of this.#olderRuns?.items ?? []) {
			if (!runs.has(run.id)) runs.set(run.id, run);
		}
		const selected = this.#selected?.run;
		if (selected && !runs.has(selected.id)) runs.set(selected.id, { ...selected, status: null });
		return runs;
	});
	readonly collapsedRunIds = new SvelteSet<string>();
	runs = $derived([...this.#runsById.values()]);
	runIdByChatId = $derived.by(() => {
		const ids = new Map<string, string>();
		for (const [chatId, active] of this.#activeByChat) ids.set(chatId, active.runId);
		if (this.#selected) ids.set(this.#selected.chatId, this.#selected.run.id);
		return ids;
	});
	moreRuns = $derived(Boolean(this.#runCursor));
	moreActiveChats = $derived(Boolean(this.#activeChats?.nextCursor));
	fetching = $state(false);
	failed = $state(false);

	constructor(
		private readonly readers: {
			runs: PageReader<WorkflowRunSummary>;
			activeChats: PageReader<WorkflowActiveChat>;
		},
	) {}

	get #runCursor(): string | null {
		return this.#olderRuns ? this.#olderRuns.nextCursor : (this.#recentRuns?.nextCursor ?? null);
	}

	runForChat(chatId: string, fromRunId?: string): SidebarWorkflowRun | undefined {
		const active = this.#activeByChat.get(chatId);
		if (active) return runFromMembership(active);
		if (fromRunId)
			return this.#runsById.get(fromRunId) ?? { id: fromRunId, name: '', status: null };
		return this.#selected?.chatId === chatId ? this.#selected.run : undefined;
	}

	selectChat(chatId: string | null, knownRun?: SidebarWorkflowRun): void {
		this.#selectedChatId = chatId;
		const run = chatId ? (knownRun ?? this.runForChat(chatId)) : undefined;
		if (chatId && run) {
			if (this.#selected?.chatId !== chatId || !sameRun(this.#selected.run, run)) {
				this.#selected = { chatId, run };
			}
		} else if (this.#selected) this.#selected = null;
	}

	toggleRunCollapsed(runId: string): void {
		if (this.collapsedRunIds.has(runId)) this.collapsedRunIds.delete(runId);
		else if (this.#runsById.has(runId)) this.collapsedRunIds.add(runId);
	}

	setLive(live: boolean): void {
		if (this.#live === live) return;
		this.#live = live;
		if (live) {
			this.invalidate();
		} else {
			this.#refreshPending = false;
			this.#clearTimer();
			this.#request?.abort();
			this.#request = null;
			this.fetching = false;
		}
	}

	invalidate(): void {
		if (!this.#live) return;
		if (this.#request) {
			this.#refreshPending = true;
			return;
		}
		void this.#fetch(async (signal) => {
			const [runs, activeChats] = await Promise.all([
				this.readers.runs({ limit: RUN_PAGE_SIZE, signal }),
				this.#readActiveChats(signal),
			]);
			if (signal.aborted) return;
			if (!samePage(this.#recentRuns, runs, sameRun)) this.#recentRuns = runs;
			if (
				!samePage(
					this.#activeChats,
					activeChats,
					(a, b) =>
						a.chatId === b.chatId &&
						a.runId === b.runId &&
						a.runName === b.runName &&
						a.runStatus === b.runStatus,
				)
			)
				this.#activeChats = activeChats;
			this.selectChat(this.#selectedChatId);
			for (const id of this.collapsedRunIds) {
				if (!this.#runsById.has(id)) this.collapsedRunIds.delete(id);
			}
		});
	}

	loadMore(kind: SidebarWorkflowPageKind): void {
		if (!this.#live || this.#request) return;
		const cursor = kind === 'runs' ? this.#runCursor : this.#activeChats?.nextCursor;
		if (!cursor) return;
		void this.#fetch(async (signal) => {
			if (kind === 'runs') {
				const page = await this.readers.runs({ cursor, limit: RUN_PAGE_SIZE, signal });
				if (!signal.aborted)
					this.#olderRuns = {
						items: [...(this.#olderRuns?.items ?? []), ...page.items],
						nextCursor: page.nextCursor,
					};
			} else {
				const page = await this.readers.activeChats({
					cursor,
					limit: ACTIVE_CHAT_PAGE_SIZE,
					signal,
				});
				if (signal.aborted) return;
				this.#activePageCount++;
				this.#activeChats = {
					items: [...(this.#activeChats?.items ?? []), ...page.items],
					nextCursor: page.nextCursor,
				};
				this.selectChat(this.#selectedChatId);
			}
		});
	}

	async #readActiveChats(signal: AbortSignal): Promise<WorkflowPage<WorkflowActiveChat>> {
		const items: WorkflowActiveChat[] = [];
		let cursor: string | null = null;
		for (let index = 0; index < this.#activePageCount; index++) {
			const page = await this.readers.activeChats({
				cursor: cursor ?? undefined,
				limit: ACTIVE_CHAT_PAGE_SIZE,
				signal,
			});
			items.push(...page.items);
			cursor = page.nextCursor;
			if (!cursor || signal.aborted) break;
		}
		return { items, nextCursor: cursor };
	}

	async #fetch(read: (signal: AbortSignal) => Promise<void>): Promise<void> {
		this.#clearTimer();
		const request = new AbortController();
		this.#request = request;
		this.fetching = true;
		try {
			await read(request.signal);
			if (!request.signal.aborted) this.failed = false;
		} catch {
			if (!request.signal.aborted) this.failed = true;
		} finally {
			if (this.#request === request) {
				request.abort();
				this.#request = null;
				this.fetching = false;
				if (this.#refreshPending) {
					this.#refreshPending = false;
					this.invalidate();
				} else {
					const active = this.runs.some((run) => run.status === 'running');
					this.#timer = setTimeout(
						() => this.invalidate(),
						active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS,
					);
				}
			}
		}
	}

	#clearTimer(): void {
		if (this.#timer === null) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
}
