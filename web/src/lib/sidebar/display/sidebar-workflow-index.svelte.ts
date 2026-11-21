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

function samePages<T>(
	a: readonly WorkflowPage<T>[],
	b: readonly WorkflowPage<T>[],
	equal: (a: T, b: T) => boolean,
): boolean {
	return (
		a.length === b.length &&
		a.every((page, i) => {
			const next = b[i];
			return (
				page.nextCursor === next.nextCursor &&
				page.items.length === next.items.length &&
				page.items.every((item, j) => equal(item, next.items[j]))
			);
		})
	);
}

async function readLoadedPages<T>(
	read: PageReader<T>,
	limit: number,
	count: number,
	signal: AbortSignal,
): Promise<WorkflowPage<T>[]> {
	const pages: WorkflowPage<T>[] = [];
	let cursor: string | undefined;
	do {
		const page = await read({ cursor, limit, signal });
		pages.push(page);
		cursor = page.nextCursor ?? undefined;
	} while (cursor && pages.length < count && !signal.aborted);
	return pages;
}

function runFromMembership(chat: WorkflowActiveChat): SidebarWorkflowRun {
	return { id: chat.runId, name: chat.runName, status: chat.runStatus };
}

export class SidebarWorkflowIndex {
	#runPages = $state.raw<readonly WorkflowPage<WorkflowRunSummary>[]>([]);
	#chatPages = $state.raw<readonly WorkflowPage<WorkflowActiveChat>[]>([]);
	#selected = $state.raw<{ chatId: string; run: SidebarWorkflowRun } | null>(null);
	#selectedChatId: string | null = null;
	#live = false;
	#refreshPending = false;
	#request: AbortController | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#activeByChat = $derived.by(() => {
		const chats = new Map<string, WorkflowActiveChat>();
		for (const page of this.#chatPages) {
			for (const chat of page.items) chats.set(chat.chatId, chat);
		}
		return chats;
	});
	#runsById = $derived.by(() => {
		const runs = new Map<string, SidebarWorkflowRun>();
		for (const run of this.#runPages[0]?.items ?? []) runs.set(run.id, run);
		for (const chat of this.#activeByChat.values()) {
			if (!runs.has(chat.runId)) runs.set(chat.runId, runFromMembership(chat));
		}
		for (const page of this.#runPages.slice(1)) {
			for (const run of page.items) {
				if (!runs.has(run.id)) runs.set(run.id, run);
			}
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
	moreRuns = $derived(Boolean(this.#runPages.at(-1)?.nextCursor));
	moreActiveChats = $derived(Boolean(this.#chatPages.at(-1)?.nextCursor));
	fetching = $state(false);
	failed = $state(false);

	constructor(
		private readonly readers: {
			runs: PageReader<WorkflowRunSummary>;
			activeChats: PageReader<WorkflowActiveChat>;
		},
	) {}

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
				readLoadedPages(this.readers.runs, RUN_PAGE_SIZE, this.#runPages.length, signal),
				readLoadedPages(
					this.readers.activeChats,
					ACTIVE_CHAT_PAGE_SIZE,
					this.#chatPages.length,
					signal,
				),
			]);
			if (signal.aborted) return;
			if (!samePages(this.#runPages, runs, sameRun)) this.#runPages = runs;
			if (
				!samePages(
					this.#chatPages,
					activeChats,
					(a, b) =>
						a.chatId === b.chatId &&
						a.runId === b.runId &&
						a.runName === b.runName &&
						a.runStatus === b.runStatus,
				)
			)
				this.#chatPages = activeChats;
			this.selectChat(this.#selectedChatId);
			for (const id of this.collapsedRunIds) {
				if (!this.#runsById.has(id)) this.collapsedRunIds.delete(id);
			}
		});
	}

	loadMore(kind: SidebarWorkflowPageKind): void {
		if (!this.#live || this.#request) return;
		const pages = kind === 'runs' ? this.#runPages : this.#chatPages;
		const cursor = pages.at(-1)?.nextCursor;
		if (!cursor) return;
		void this.#fetch(async (signal) => {
			if (kind === 'runs') {
				const page = await this.readers.runs({ cursor, limit: RUN_PAGE_SIZE, signal });
				if (!signal.aborted) this.#runPages = [...this.#runPages, page];
			} else {
				const page = await this.readers.activeChats({
					cursor,
					limit: ACTIVE_CHAT_PAGE_SIZE,
					signal,
				});
				if (signal.aborted) return;
				this.#chatPages = [...this.#chatPages, page];
				this.selectChat(this.#selectedChatId);
			}
		});
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
