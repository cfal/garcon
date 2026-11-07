import type { UserMessagePresentation } from '$shared/chat-types';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';

export interface UserMessageNavigatorItem {
	id: string;
	ordinal: number;
	content: string;
	timestamp: string;
	attachmentCount: number;
	presentation?: UserMessagePresentation;
}
export interface UserMessageNavigatorTarget { chatId: string; transcriptViewId: string; rowId: string; ordinal?: number }
export type UserMessageNavigatorLoadError = 'older-page-failed';
export type UserMessageNavigatorInitialLoadError = 'initial-load-failed';
export type UserMessageNavigatorSelectionError = 'target-unavailable';
export type UserMessageNavigatorSelectionResult = 'completed' | 'cancelled' | 'unavailable';
export type UserMessageNavigatorCommand = () => void;
export type UserMessageNavigatorRegistration = UserMessageNavigatorCommand | null;

export interface UserMessageNavigatorTranscriptPort {
	readonly activeChatId: string | null;
	readonly transcriptViewId: string;
	readonly serverInstanceId: string;
	readonly lastOrdinal: number;
}
export interface UserMessageNavigatorOptions {
	transcript: UserMessageNavigatorTranscriptPort;
	getSelectedChatId(): string | null;
	reloadTranscript(chatId: string): Promise<void>;
	jumpToRow(target: UserMessageNavigatorTarget): Promise<UserMessageNavigatorSelectionResult>;
	api?: Pick<TranscriptDisplayApi, 'userRows'>;
}
export interface UserMessageNavigatorDialogController {
	readonly open: boolean;
	readonly items: readonly UserMessageNavigatorItem[];
	readonly hasMore: boolean;
	readonly isInitialLoading: boolean;
	readonly initialLoadError: UserMessageNavigatorInitialLoadError | null;
	readonly isLoadingOlder: boolean;
	readonly loadError: UserMessageNavigatorLoadError | null;
	readonly selectionError: UserMessageNavigatorSelectionError | null;
	close(): void;
	retryInitialLoad(): Promise<void>;
	loadOlder(): Promise<void>;
	retryLoadOlder(): Promise<void>;
	select(item: UserMessageNavigatorItem): Promise<void>;
}

export class UserMessageNavigatorController implements UserMessageNavigatorDialogController {
	open = $state(false);
	openedChatId = $state<string | null>(null);
	openedTranscriptViewId = $state<string | null>(null);
	items = $state.raw<readonly UserMessageNavigatorItem[]>([]);
	isLoadingOlder = $state(false);
	isInitialLoading = $state(false);
	initialLoadError = $state<UserMessageNavigatorInitialLoadError | null>(null);
	loadError = $state<UserMessageNavigatorLoadError | null>(null);
	selectionError = $state<UserMessageNavigatorSelectionError | null>(null);
	#before = $state<number | null>(null);
	#watermark = 0;
	#epoch = 0;
	#abort: AbortController | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: UserMessageNavigatorOptions) {}
	get hasMore(): boolean { return this.open && this.#before !== null; }

	async openForActiveChat(): Promise<void> {
		const chatId = this.options.getSelectedChatId();
		if (!chatId || this.options.transcript.activeChatId !== chatId) return;
		this.close();
		this.open = true;
		this.openedChatId = chatId;
		this.openedTranscriptViewId = this.options.transcript.transcriptViewId || null;
		this.#watermark = this.options.transcript.lastOrdinal;
		await this.#load(true);
	}
	close(): void {
		this.#epoch++;
		this.#abort?.abort();
		this.#abort = null;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.open = false;
		this.openedChatId = null;
		this.openedTranscriptViewId = null;
		this.items = [];
		this.#before = null;
		this.isLoadingOlder = this.isInitialLoading = false;
		this.loadError = this.initialLoadError = this.selectionError = null;
	}
	reconcileActiveTranscript(chatId: string | null, view: string): void {
		if (this.open && (chatId !== this.openedChatId || (this.openedTranscriptViewId && view !== this.openedTranscriptViewId))) this.close();
	}
	retryInitialLoad(): Promise<void> { return this.#load(true); }
	loadOlder(): Promise<void> { return this.hasMore ? this.#load(false) : Promise.resolve(); }
	retryLoadOlder(): Promise<void> { return this.loadOlder(); }

	async #load(initial: boolean): Promise<void> {
		const chatId = this.openedChatId;
		if (!this.open || !chatId || this.#abort) return;
		const epoch = this.#epoch, abort = new AbortController();
		this.#abort = abort;
		if (initial) { this.isInitialLoading = true; this.initialLoadError = null; }
		else { this.isLoadingOlder = true; this.loadError = null; }
		try {
			if (!this.openedTranscriptViewId) {
				await this.options.reloadTranscript(chatId);
				if (epoch !== this.#epoch) return;
				this.openedTranscriptViewId = this.options.transcript.transcriptViewId || null;
				this.#watermark = this.options.transcript.lastOrdinal;
			}
			const view = this.openedTranscriptViewId;
			if (!view) throw new Error('Transcript unavailable');
			const response = await (this.options.api ?? transcriptDisplayApi).userRows({ chatId, transcriptViewId: view,
				mode: 'navigation', limit: 50, atWatermark: this.#watermark, ...(!initial && this.#before !== null ? { beforeOrdinal: this.#before } : {}) }, abort.signal);
			if (epoch !== this.#epoch || abort.signal.aborted) return;
			if (response.chatId !== chatId || response.transcriptViewId !== view
				|| response.serverInstanceId !== this.options.transcript.serverInstanceId) throw new Error('Foreign user-row page');
			if (response.kind === 'failed') throw new Error(response.errorCode ?? 'User-row index unavailable');
			if (response.kind === 'preparing') {
				this.#timer = setTimeout(() => { this.#timer = null; void this.#load(initial); }, 1000);
				return;
			}
			if (response.kind !== 'available') return;
			if (response.watermark !== this.#watermark || !initial && this.#before !== null
				&& response.rows.some(row => row.ordinal >= this.#before!)) throw new Error('Invalid user-row continuation');
			const items = response.rows.map(row => ({ id: `${view}:${row.ordinal}`, ordinal: row.ordinal,
				content: row.preview, timestamp: row.timestamp, attachmentCount: row.attachmentCount, presentation: row.presentation }));
			this.items = initial ? items : [...this.items, ...items];
			this.#before = response.nextBeforeOrdinal;
		} catch {
			if (epoch !== this.#epoch || abort.signal.aborted) return;
			if (initial) this.initialLoadError = 'initial-load-failed';
			else this.loadError = 'older-page-failed';
		} finally {
			if (epoch === this.#epoch) {
				this.#abort = null;
				if (this.#timer === null) this.isInitialLoading = this.isLoadingOlder = false;
			}
		}
	}
	async select(item: UserMessageNavigatorItem): Promise<void> {
		const chatId = this.openedChatId, view = this.openedTranscriptViewId;
		if (!this.open || !chatId || !view || !this.items.includes(item)) return;
		const epoch = ++this.#epoch;
		this.#abort?.abort();
		this.#abort = null;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.isInitialLoading = this.isLoadingOlder = false;
		this.selectionError = null;
		this.open = false;
		const result = await this.options.jumpToRow({ chatId, transcriptViewId: view, rowId: item.id, ordinal: item.ordinal }).catch(() => 'unavailable' as const);
		if (epoch !== this.#epoch) return;
		if (result === 'unavailable' && this.options.getSelectedChatId() === chatId && this.options.transcript.transcriptViewId === view) {
			this.open = true;
			this.selectionError = 'target-unavailable';
		} else this.close();
	}
}
