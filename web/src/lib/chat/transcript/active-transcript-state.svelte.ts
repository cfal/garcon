import { UserMessage, type ChatMessage } from '$shared/chat-types';
import { untrack } from 'svelte';
import type { UserRowSummary } from '$shared/transcript-display-auxiliary';
import type { TranscriptMessage } from '$shared/chat-view';
import type { DisplayCut, DisplayProfile, GroupDescriptor, MemberWindowRequest } from '$shared/transcript-display-contract';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { DisplayBodyStore } from './display-body-store.js';
import { DisplayWindowController, emptyDisplayWindow } from './display-window-controller.js';
import { displayRenderModel } from './display-render-model.js';
import { ConversationFeedMutationState } from './ConversationFeedMutationState.svelte.js';
import { ConversationTranscriptOverlayStore, type ConversationTranscriptOverlayView, type ConversationTranscriptOverlayMutation } from './conversation-transcript-overlay-store.svelte.js';
import type { LocalNoticeRow, LocalNoticeType } from './local-notice.js';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import type { ActiveTranscriptPort, ChatCursor, ChatLoadMessagesOptions } from './active-transcript-port.js';
import { idlePageState, type TranscriptPageApplicationGate, type TranscriptPageLoadOptions, type TranscriptPageLoadResult, type TranscriptPageState, type TranscriptWindowTarget, type TranscriptWindowLoadResult } from './transcript-page-progress.js';
import type { TranscriptRowTarget, TranscriptRowWindowResult } from './transcript-row-navigation.js';
import type { ChatDisplayRow } from './transcript-row-projection.js';
import { selectForkAtMessage } from '$lib/chat/actions/fork-at-message-action.js';
import { emptyResponseClassOrdinals, RESPONSE_CLASSES, type ResponseClassOrdinals, type ChatDisplayStateUpdatedMessage } from '$shared/transcript-display-events';

export type { ActiveTranscriptPort, ChatCursor, ChatLoadMessagesOptions } from './active-transcript-port.js';
export type { ChatDisplayRow, ChatTranscriptRow } from './transcript-row-projection.js';
export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ActiveTranscriptState implements ActiveTranscriptPort {
	activeChatId = $state<string | null>(null);
	transcriptViewId = $state('');
	serverInstanceId = $state('');
	lastOrdinal = $state(0);
	windowRevision = $state(0);
	readinessRevision = $state(0);
	isUserScrolledUp = $state(false);
	display = $state.raw(emptyDisplayWindow());
	openSnapshot = $state.raw<DisplayOpenResponse | null>(null);
	responseClassOrdinals = $state.raw<ResponseClassOrdinals>(emptyResponseClassOrdinals());
	pageStates = $state<Record<'earlier' | 'later', TranscriptPageState>>({ earlier: idlePageState(), later: idlePageState() });
	#opening = $state(false);
	#openError = $state<string | null>(null);
	#profile: Omit<DisplayProfile, 'bashRevision'> = { combine: true, showThinking: true, hiddenToolGroups: [] };
	#permissionCuts: readonly DisplayCut[] = [];
	#openEpoch = 0;
	#pageEpoch = 0;
	#openAbort: AbortController | null = null;
	#navigating = false;
	#navigationEpoch = 0;
	#representedNotices = $state.raw<ReadonlySet<string>>(new Set());
	readonly #stopNoticeTracking: () => void;
	#committedInputs = $state.raw<ReadonlyMap<string, { input: OptimisticUserInput; view: string; ordinal: number; afterOrdinal: number }>>(new Map());
	#localOverlays = new ConversationTranscriptOverlayStore();
	#emptyOverlay = this.#localOverlays.forChat('');
	#mutations = new ConversationFeedMutationState();
	readonly controller: DisplayWindowController;
	readonly #sharedOverlay: ConversationTranscriptOverlayView | null;
	#renderModel = $derived.by(() => displayRenderModel(this.display, this.bodyStore));
	#entries = $derived(this.#renderModel.items.flatMap(item => item.kind === 'message' && item.ordinal !== undefined
		? [{ ordinal: item.ordinal, message: item.message }] : []).sort((a, b) => a.ordinal - b.ordinal));

	constructor(readonly bodyStore = new DisplayBodyStore(), sharedOverlay: ConversationTranscriptOverlayView | null = null,
		api: Pick<TranscriptDisplayApi, 'open' | 'window' | 'members' | 'bodies' | 'resolve' | 'retry'> = transcriptDisplayApi,
		private readonly onInputRepresented?: (view: string, clientMessageId: string, ordinal: number) => void) {
		this.#sharedOverlay = sharedOverlay;
		this.controller = new DisplayWindowController(bodyStore, (snapshot, direction) => {
			const before = this.display.window;
			this.display = snapshot;
			this.#rememberNoticeProofs();
			this.#releaseRepresentedInputs();
			if (snapshot.window && snapshot.window !== before) {
				this.lastOrdinal = Math.max(this.lastOrdinal, snapshot.window.sourceHead);
				if (!direction) this.#mutations.record(before ? 'presentation-structure' : 'initial');
			}
			if (direction) this.#mutations.record(direction === 'earlier' ? 'history-earlier' : 'history-later');
		}, api);
		this.#stopNoticeTracking = $effect.root(() => {
			$effect(() => {
				const notices = this.overlay.notices, window = this.display.window;
				untrack(() => this.#rememberNoticeProofs(notices, window));
			});
		});
	}
	#releaseRepresentedInputs(): void {
		// Navigation resolves against its installed certificate before retiring overlay cuts.
		const window = this.display.window;
		if (!window || this.#navigating) return;
		const remaining = new Map(this.#committedInputs);
		for (const [id, committed] of remaining) {
			if (window.certificate.transcriptViewId !== committed.view
				|| !window.items.some(item => item.kind === 'row' && item.ordinal === committed.ordinal)) continue;
			remaining.delete(id);
			queueMicrotask(() => {
				if (this.transcriptViewId === committed.view) this.onInputRepresented?.(committed.view, id, committed.ordinal);
			});
		}
		if (remaining.size === this.#committedInputs.size) return;
		this.#committedInputs = remaining;
		queueMicrotask(() => { if (!this.#navigating) this.#configureCuts(); });
	}

	get renderModel() { return this.#renderModel; }
	get entries(): readonly TranscriptMessage[] { return this.#entries; }
	get chatMessages(): ChatMessage[] { return this.#entries.map(entry => entry.message); }
	get feedMutationClock() { return this.#mutations.clock; }
	get loadedThroughOrdinal(): number { return this.display.window?.certificate.watermark ?? 0; }
	get hasEarlierMessages(): boolean { return this.display.window?.earlier.kind === 'more'; }
	get hasLaterMessages(): boolean { return this.display.window?.later.kind === 'more'; }
	get isDisplayBehindHead(): boolean { return this.display.window !== null && this.loadedThroughOrdinal < this.lastOrdinal; }
	get canLoadEarlier(): boolean { return this.hasEarlierMessages; }
	get isLoadingMessages(): boolean { return this.#opening || ['requesting', 'preparing', 'lagging', 'busy'].includes(this.display.phase); }
	get canLoadMembers(): boolean { return this.controller.canLoadMembers; }
	get loadError(): string | null { return this.#openError ?? this.display.error; }
	get loadStatus(): ChatLoadStatus {
		if (this.loadError || this.display.phase === 'failed') return 'error';
		if (this.display.window) return this.displayMessageCount ? 'loaded' : 'empty';
		return this.isLoadingMessages ? 'loading' : 'idle';
	}
	get overlay(): ConversationTranscriptOverlayView { return this.#sharedOverlay ?? this.#localOverlays.viewFor(this.activeChatId ?? '') ?? this.#emptyOverlay; }
	get localNotices() { return this.overlay.notices.filter(notice => !this.#representedNotices.has(notice.id) && !this.#noticeRepresented(notice)); }
	#noticeRepresented(notice: LocalNoticeRow, window = this.display.window): boolean {
		const barrier = notice.transcriptBarrier, tail = window?.publicTail, certificate = window?.certificate;
		return !!barrier && !!notice.contentDigest && !!tail && !!certificate
			&& (notice.noticeType === 'error' || notice.noticeType === 'warning')
			&& barrier.serverInstanceId === certificate.serverInstanceId && barrier.transcriptViewId === certificate.transcriptViewId
			&& certificate.watermark >= barrier.ordinal
			&& (notice.contentDigest === tail.contentDigest || notice.contentDigest === tail.combinedDigest);
	}
	#rememberNoticeProofs(notices = this.overlay.notices, window = this.display.window): void {
		const represented = new Set(notices.filter(notice => this.#representedNotices.has(notice.id) || this.#noticeRepresented(notice, window)).map(notice => notice.id));
		if (represented.size !== this.#representedNotices.size || [...represented].some(id => !this.#representedNotices.has(id))) this.#representedNotices = represented;
	}
	get optimisticUserInputs() { return this.overlay.optimisticInputs; }
	get optimisticAfterOrdinals() {
		const anchors = new Map(this.overlay.optimisticAfterOrdinals);
		for (const [id, committed] of this.#committedInputs) if (committed.view === this.transcriptViewId) anchors.set(id, Math.max(anchors.get(id) ?? 0, committed.afterOrdinal));
		return anchors;
	}
	get visibleOptimisticInputs(): readonly OptimisticUserInput[] {
		const certificate = this.display.window?.certificate;
		const represented = new Set(this.entries.flatMap(entry => {
			const id = certificate && this.bodyStore.get(certificate, entry.ordinal)?.submissionClientMessageId;
			return id ? [id] : [];
		}));
		const inputs = new Map(this.optimisticUserInputs.map(input => [input.clientMessageId, input]));
		for (const [id, committed] of this.#committedInputs) if (committed.view === this.transcriptViewId) inputs.set(id, committed.input);
		return [...inputs.values()].filter(input => !represented.has(input.clientMessageId));
	}
	acknowledgeInput(view: string, input: OptimisticUserInput, ordinal: number, afterOrdinal: number): void {
		if (this.display.window?.certificate.transcriptViewId !== view
			|| !this.display.window.items.some(item => item.kind === 'row' && item.ordinal === ordinal)) {
			this.#committedInputs = new Map(this.#committedInputs).set(input.clientMessageId, { input: { ...input, delivery: 'delivered' }, view, ordinal, afterOrdinal });
		}
		if (!this.#navigating) this.#configureCuts();
	}
	get overlayRows(): ChatDisplayRow[] {
		return [...this.visibleOptimisticInputs.map(input => ({ kind: 'message' as const, id: `optimistic:${input.clientMessageId}`,
			message: new UserMessage(input.createdAt, input.content, input.images, { clientMessageId: input.clientMessageId,
				...(input.contentMode ? { contentMode: input.contentMode } : {}), ...(input.contentFormat ? { contentFormat: input.contentFormat } : {}) }),
			awaitingDelivery: input.delivery === 'pending' })), ...this.localNotices];
	}
	get visibleRows(): ChatDisplayRow[] {
		const canonical = this.#renderModel.items.flatMap(item => item.kind === 'message' ? [item] : [])
			.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
		return [...canonical, ...this.overlayRows];
	}
	get displayRows(): readonly ChatDisplayRow[] { return this.visibleRows; }
	get displayMessages(): ChatMessage[] { return this.visibleRows.flatMap(row => row.kind === 'message' ? [row.message] : []); }
	get displayMessageCount(): number {
		const protectedOrdinals = new Set(this.display.protectedRows.map(row => row.detail.ordinal));
		const retained = this.#renderModel.items.filter(item => item.kind === 'message' && item.ordinal !== undefined && protectedOrdinals.has(item.ordinal));
		return (this.display.window?.items.length ?? 0) + retained.length + this.display.protectedGroups.length + this.overlayRows.length;
	}
	get resendCandidates(): readonly UserRowSummary[] { return this.overlay.includedResendCandidates; }
	get excludedResendOrdinals(): readonly number[] { return this.overlay.excludedResendOrdinals; }
	getCursor(): ChatCursor { return { transcriptViewId: this.transcriptViewId, lastOrdinal: this.lastOrdinal }; }
	forkSelection(ordinal: number) {
		const certificate = this.display.window?.certificate;
		return certificate ? selectForkAtMessage(this.bodyStore.get(certificate, ordinal), this.transcriptViewId) : null;
	}
	setDisplayApplicationGate(gate: TranscriptPageApplicationGate | undefined): void { this.controller.setApplicationGate(gate); }

	configureDisplay(profile: Omit<DisplayProfile, 'bashRevision'>, permissionCuts: readonly DisplayCut[] = []): void {
		this.#profile = profile;
		this.#permissionCuts = permissionCuts;
		if (!this.#navigating) this.#configureCuts();
	}
	#configureCuts(): void {
		const cuts = this.visibleOptimisticInputs.map(input => ({ id: `optimistic:${input.clientMessageId}`,
			afterOrdinal: this.optimisticAfterOrdinals.get(input.clientMessageId) ?? this.lastOrdinal, anchorRule: 'raw-position' as const }));
		this.controller.configure({ ...this.#profile, bashRevision: this.controller.profile?.bashRevision ?? '' }, [...cuts, ...this.#permissionCuts]);
	}

	installOpen(snapshot: DisplayOpenResponse): void {
		if (snapshot.chat.id !== this.activeChatId) return;
		const replaced = this.transcriptViewId !== '' && this.transcriptViewId !== snapshot.transcriptViewId;
		if (!this.#navigating || replaced || this.serverInstanceId !== snapshot.serverInstanceId) this.invalidatePendingHistoryLoad();
		if (replaced) {
			this.windowRevision += 1;
			this.responseClassOrdinals = emptyResponseClassOrdinals();
		}
		this.#committedInputs = new Map([...this.#committedInputs].filter(([, input]) => input.view === snapshot.transcriptViewId));
		this.openSnapshot = snapshot;
		this.serverInstanceId = snapshot.serverInstanceId;
		this.transcriptViewId = snapshot.transcriptViewId;
		this.lastOrdinal = replaced ? snapshot.sourceHead : Math.max(this.lastOrdinal, snapshot.sourceHead);
		this.controller.installOpen(snapshot, { ...this.#profile, bashRevision: snapshot.display.bashRevision });
		if (!this.#sharedOverlay) for (const submission of snapshot.submissions) {
			const input = this.optimisticUserInputs.find(input => input.clientMessageId === submission.clientMessageId);
			if (!input || submission.ordinal === null) continue;
			this.acknowledgeInput(snapshot.transcriptViewId, input, submission.ordinal, this.optimisticAfterOrdinals.get(input.clientMessageId) ?? 0);
			this.#localOverlays.acknowledgeInput(snapshot.chat.id, input.clientMessageId, submission.ordinal);
		}
		if (!this.#navigating) this.#configureCuts();
		this.#opening = false;
		this.#openError = null;
	}

	displayReady(message: ChatDisplayStateUpdatedMessage): void {
		if (message.chatId !== this.activeChatId || message.transcriptViewId !== this.transcriptViewId || message.serverInstanceId !== this.serverInstanceId) return;
		this.readinessRevision += 1;
		this.controller.ready(message.bashRevision, message.phase);
	}
	beginOpen(): void { this.#opening = true; this.#openError = null; }
	cancelOpen(): void { this.#openEpoch += 1; this.#openAbort?.abort(); this.#openAbort = null; this.#opening = false; }
	failOpen(error: unknown): void {
		this.#opening = false;
		this.#openError = error instanceof Error ? error.message : 'Unable to open transcript';
	}

	async loadMessages(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<ChatMessage[]> {
		if (this.activeChatId !== chatId) this.activateChat(chatId);
		const epoch = ++this.#openEpoch;
		this.#openAbort?.abort();
		const abort = new AbortController();
		this.#openAbort = abort;
		this.#opening = true;
		this.#openError = null;
		try {
			const snapshot = await transcriptDisplayApi.open({ chatId, reason: options.purpose === 'activation' ? 'activate' : 'reconnect',
				outstandingClientMessageIds: this.optimisticUserInputs.map(input => input.clientMessageId).slice(0, 32) }, abort.signal);
			if (epoch !== this.#openEpoch || this.activeChatId !== chatId) return [];
			this.installOpen(snapshot);
			await this.controller.refresh();
			return this.chatMessages;
		} catch (error) {
			if (epoch !== this.#openEpoch || abort.signal.aborted) return [];
			this.#openError = error instanceof Error ? error.message : 'Unable to open transcript';
			throw error;
		} finally { if (epoch === this.#openEpoch) { this.#opening = false; this.#openAbort = null; } }
	}

	observeHead(view: string, ordinal: number, responseOrdinals: ResponseClassOrdinals = emptyResponseClassOrdinals()): void {
		if (view !== this.transcriptViewId) return;
		const responseTypes = RESPONSE_CLASSES.filter(key => responseOrdinals[key] > this.responseClassOrdinals[key]);
		const next = { ...this.responseClassOrdinals };
		for (const key of RESPONSE_CLASSES) next[key] = Math.max(next[key], responseOrdinals[key]);
		this.responseClassOrdinals = next;
		if (ordinal > this.lastOrdinal) this.#mutations.record('live-append', [...responseTypes]);
		this.lastOrdinal = Math.max(this.lastOrdinal, ordinal);
		this.controller.observeHead(view, ordinal);
	}
	applySharedOverlayMutation(mutation: ConversationTranscriptOverlayMutation): void {
		if (!mutation.feedStructureChanged) return;
		this.#mutations.record('presentation-structure');
		if (!this.#navigating) this.#configureCuts();
	}
	async #loadPage(direction: 'earlier' | 'later', chatId: string, options: TranscriptPageLoadOptions = {}): Promise<TranscriptPageLoadResult> {
		if (chatId !== this.activeChatId || this.controller.busy) return 'invalidated';
		const epoch = ++this.#pageEpoch;
		const target = options.memberTarget;
		if (!target) this.pageStates[direction] = { status: 'loading', error: this.pageStates[direction].error };
		const result = target ? await this.controller.extendMembers(target.group, target.anchor, options.applicationGate)
			: await this.controller.load(direction, options.applicationGate);
		if (epoch !== this.#pageEpoch) return 'invalidated';
		if (!target) this.pageStates[direction] = result === 'failed' ? { status: 'error', error: this.loadError } : idlePageState();
		return result === 'blocked' ? 'invalidated' : result;
	}
	loadEarlierPage(chatId: string, options?: TranscriptPageLoadOptions): Promise<TranscriptPageLoadResult> { return this.#loadPage('earlier', chatId, options); }
	loadLaterPage(chatId: string, options?: TranscriptPageLoadOptions): Promise<TranscriptPageLoadResult> { return this.#loadPage('later', chatId, options); }
	async navigateToWindow(chatId: string, target: TranscriptWindowTarget): Promise<TranscriptWindowLoadResult> {
		if (chatId !== this.activeChatId) return 'invalidated';
		this.invalidatePendingWindowNavigation();
		this.invalidatePendingHistoryLoad();
		const epoch = ++this.#navigationEpoch;
		this.#navigating = true;
		try {
			const result = await this.controller.navigateWindow(target);
			if (epoch !== this.#navigationEpoch) return 'invalidated';
			if (result === 'loaded') {
				this.#mutations.record('replacement');
				return 'loaded';
			}
			return result === 'failed' ? 'failed' : 'invalidated';
		} finally {
			this.#finishNavigation(epoch);
		}
	}
	async navigateToRow(target: TranscriptRowTarget, signal: AbortSignal, ownsNavigation: () => boolean): Promise<TranscriptRowWindowResult> {
		if (signal.aborted || !ownsNavigation() || this.activeChatId !== target.chatId) return 'cancelled';
		if (target.transcriptViewId !== this.transcriptViewId) return 'view-changed';
		if (this.#opening) return 'unavailable';
		const epoch = ++this.#navigationEpoch;
		const current = () => epoch === this.#navigationEpoch && !signal.aborted && ownsNavigation() && this.activeChatId === target.chatId;
		this.#navigating = true;
		try {
			const resolution = await this.controller.navigate(target.ordinal, signal, current);
			if (!current()) return 'cancelled';
			if (this.transcriptViewId !== target.transcriptViewId || resolution?.kind === 'stale-view') return 'view-changed';
			if (!resolution || resolution.landedOrdinal === null || !['visible-row', 'group-member', 'attached-detail', 'filtered'].includes(resolution.kind)) return 'unavailable';
			this.isUserScrolledUp = true;
			this.#mutations.record('replacement');
			return { kind: 'loaded', landedOrdinal: resolution.landedOrdinal, revealDetail: resolution.kind === 'attached-detail', targetMatched: resolution.kind !== 'filtered' };
		} finally {
			this.#finishNavigation(epoch);
		}
	}
	#finishNavigation(epoch: number): void {
		if (epoch !== this.#navigationEpoch) return;
		this.#navigating = false;
		this.#releaseRepresentedInputs();
		this.#configureCuts();
	}
	expandGroup(group: GroupDescriptor, anchor?: MemberWindowRequest['anchor']) { return this.controller.expand(group, anchor); }
	collapseGroup(group: GroupDescriptor): void { this.controller.collapse(group); }
	invalidatePendingHistoryLoad(): void {
		this.#pageEpoch += 1;
		this.pageStates = { earlier: idlePageState(), later: idlePageState() };
		this.controller.cancel();
	}
	invalidatePendingWindowNavigation(): void { this.#navigationEpoch += 1; if (this.#navigating) this.controller.cancel(); this.#navigating = false; }
	invalidatePendingLoads(): void { this.invalidatePendingWindowNavigation(); this.cancelOpen(); this.invalidatePendingHistoryLoad(); }
	suspendForParking(): boolean { this.invalidatePendingLoads(); this.controller.park(); return this.display.window !== null; }
	clearMessages(): void { this.invalidatePendingLoads(); this.controller.reset(); this.#committedInputs = new Map(); this.transcriptViewId = ''; this.lastOrdinal = 0; this.openSnapshot = null; this.responseClassOrdinals = emptyResponseClassOrdinals(); this.windowRevision += 1; }
	resetForNewChat(): void { this.clearMessages(); this.isUserScrolledUp = false; }
	activateChat(chatId: string | null): void { this.resetForNewChat(); this.activeChatId = chatId; }
	dispose(): void { this.#stopNoticeTracking(); this.invalidatePendingLoads(); this.controller.dispose(); }
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void { if (!this.#sharedOverlay && this.activeChatId) this.#localOverlays.appendLocalNotice(this.activeChatId, noticeType, content); }
	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void { if (!this.#sharedOverlay) this.#localOverlays.appendServerNotice(chatId, noticeType, content); }
	clearLocalNotices(): void { if (!this.#sharedOverlay && this.activeChatId) this.#localOverlays.clearNoticesThrough(this.activeChatId); }
	upsertOptimisticUserInput(input: OptimisticUserInput): void { if (!this.#sharedOverlay) { this.#localOverlays.upsertOptimisticInput(input.chatId, input, this.lastOrdinal); this.#configureCuts(); } }
	markOptimisticUserInputDelivered(id: string): void { if (!this.#sharedOverlay && this.activeChatId) this.#localOverlays.markOptimisticInputDelivered(this.activeChatId, id); }
	clearOptimisticUserInput(id: string): void { if (!this.#sharedOverlay && this.activeChatId) { this.#localOverlays.clearOptimisticInput(this.activeChatId, id); this.#configureCuts(); } }
	setResendCandidates(candidates: readonly UserRowSummary[]): void { if (!this.#sharedOverlay && this.activeChatId) this.#localOverlays.replaceResendCandidates(this.activeChatId, candidates); }
	excludeResendCandidate(ordinal: number): void { if (!this.#sharedOverlay && this.activeChatId) this.#localOverlays.excludeResendCandidate(this.activeChatId, ordinal); }
	clearResendExclusions(): void { if (!this.#sharedOverlay && this.activeChatId) this.#localOverlays.clearResendExclusions(this.activeChatId); }
}
