import type { PlanPresentationSnapshot, PlanPresentationRequest } from '$shared/transcript-display-open';
import type { PermissionMode } from '$lib/types/chat';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import type { ConversationUiPort } from './conversation-ui-state.svelte.js';
import type { DisplaySummaryPaging } from '$lib/chat/transcript/display-summary-controller.svelte.js';

export function planOccurrenceId(view: string, ordinal: number): string { return `plan:${view}:${ordinal}`; }
export interface PlanPresentationView extends DisplaySummaryPaging { readonly pendingExitCount: number }
export interface PlanPresentationPort {
	isCurrent(request: PlanPresentationRequest): boolean;
	getPermissionMode(chatId: string): PermissionMode | null;
	setPermissionMode(chatId: string, mode: PermissionMode): void;
	isRenderedChat(chatId: string): boolean;
	conversationUi: Pick<ConversationUiPort, 'beginPlanModeForChat' | 'updatePendingPermissionsForChat' | 'setPlanPresentation'>;
	onError(chatId: string, message: string): void;
}
interface PlanRefresh {
	request: PlanPresentationRequest;
	identity: string;
	revision: number;
	enter: number | null;
	abort: AbortController;
	snapshot: PlanPresentationSnapshot | null;
	index: number;
	before: number[];
	loading: boolean;
	error: string | null;
	selectionEpoch: number;
	pending: { request: PlanPresentationRequest; before: number[]; index: number } | null;
	metadataPending: boolean;
}
export class PlanPresentationController {
	#chats = new Map<string, PlanRefresh>();
	constructor(private readonly port: PlanPresentationPort, private readonly api: Pick<TranscriptDisplayApi, 'plan' | 'planDetail'> = transcriptDisplayApi) {}

	refresh(request: PlanPresentationRequest, revision: number, knownThrough: number | null = null): void {
		if (!this.port.isCurrent(request)) return;
		const previous = this.#chats.get(request.chatId);
		const sameIdentity = previous?.identity === this.#identity(request);
		if (sameIdentity && previous.revision >= revision) return;
		if (sameIdentity) request = { ...request, afterOrdinal: previous.request.afterOrdinal };
		const refresh = this.#begin(request, revision, knownThrough);
		void this.#read(request, refresh);
	}
	install(snapshot: PlanPresentationSnapshot): void {
		if (!this.port.isCurrent(snapshot)) return;
		const previous = this.#chats.get(snapshot.chatId);
		const sameIdentity = previous?.identity === this.#identity(snapshot);
		if (sameIdentity && previous.revision > snapshot.revision) return;
		if (sameIdentity && previous.revision === snapshot.revision && previous.snapshot) {
			if (!previous.loading) void this.#select(snapshot.chatId, previous);
			return;
		}
		if (sameIdentity && previous.request.afterOrdinal) {
			this.refresh(previous.request, snapshot.revision);
			return;
		}
		const refresh = this.#begin(snapshot, snapshot.revision);
		void this.#install(snapshot, refresh).catch(error => this.#failed(snapshot.chatId, refresh, error));
	}
	remove(chatId: string): void {
		this.#chats.get(chatId)?.abort.abort();
		this.#chats.delete(chatId);
		this.port.conversationUi.setPlanPresentation(chatId, null);
		this.port.conversationUi.updatePendingPermissionsForChat(chatId, previous => previous.filter(request => !request.planReference));
	}
	destroy(): void { for (const chatId of this.#chats.keys()) this.remove(chatId); }
	#identity(request: PlanPresentationRequest): string { return JSON.stringify([request.serverInstanceId, request.transcriptViewId]); }
	#begin(request: PlanPresentationRequest, revision: number, knownThrough: number | null = null): PlanRefresh {
		const previous = this.#chats.get(request.chatId), identity = this.#identity(request);
		previous?.abort.abort();
		const sameIdentity = previous?.identity === identity;
		const refresh: PlanRefresh = { request, identity, revision, enter: sameIdentity ? previous.enter : knownThrough,
			abort: new AbortController(), snapshot: sameIdentity ? previous.snapshot : null,
			index: sameIdentity ? previous.index : 0, before: sameIdentity ? previous.before : [],
			loading: true, error: null, selectionEpoch: 0, pending: null, metadataPending: false };
		this.#chats.set(request.chatId, refresh);
		this.#publish(request.chatId, refresh);
		return refresh;
	}
	async #read(request: PlanPresentationRequest, refresh: PlanRefresh): Promise<void> {
		refresh.metadataPending = true;
		try {
			const snapshot = await this.api.plan(request, refresh.abort.signal);
			if (!this.#current(request.chatId, refresh)) return;
			if (snapshot.chatId !== request.chatId || this.#identity(snapshot) !== refresh.identity) throw new Error('Foreign plan snapshot');
			refresh.request = request;
			refresh.metadataPending = false;
			await this.#install(snapshot, refresh);
		}
		catch (error) { this.#failed(request.chatId, refresh, error); }
	}
	async #install(snapshot: PlanPresentationSnapshot, refresh: PlanRefresh): Promise<void> {
		if (!this.#current(snapshot.chatId, refresh)) return;
		if (this.#identity(snapshot) !== refresh.identity) throw new Error('Transcript changed while reading plans');
		const selected = refresh.snapshot?.exits[refresh.index]?.ordinal;
		if (refresh.pending) {
			refresh.before = refresh.pending.before;
			refresh.index = refresh.pending.index < 0 ? snapshot.exits.length - 1 : refresh.pending.index;
			refresh.pending = null;
		} else if (selected !== undefined) {
			refresh.index = Math.max(0, snapshot.exits.findIndex(exit => exit.ordinal === selected));
		}
		const enter = snapshot.latestEnterOrdinal ?? 0;
		if (refresh.enter !== null && enter > refresh.enter) {
			const previous = this.port.getPermissionMode(snapshot.chatId);
			if (previous && previous !== 'plan') this.port.conversationUi.beginPlanModeForChat(snapshot.chatId, previous);
			this.port.setPermissionMode(snapshot.chatId, 'plan');
		}
		refresh.enter = Math.max(refresh.enter ?? 0, enter);
		refresh.snapshot = snapshot;
		refresh.revision = snapshot.revision;
		await this.#select(snapshot.chatId, refresh);
	}
	async #select(chatId: string, refresh: PlanRefresh): Promise<void> {
		const snapshot = refresh.snapshot;
		if (!snapshot || !this.#current(chatId, refresh)) return;
		const epoch = ++refresh.selectionEpoch;
		refresh.loading = true;
		refresh.error = null;
		this.#publish(chatId, refresh);
		try {
			const exit = snapshot.exits[refresh.index];
			const planReference = exit ? { serverInstanceId: snapshot.serverInstanceId, chatId,
				transcriptViewId: snapshot.transcriptViewId, ordinal: exit.ordinal } : null;
			const detail = planReference && this.port.isRenderedChat(chatId) ? await this.api.planDetail(planReference, refresh.abort.signal) : null;
			if (!this.#current(chatId, refresh) || epoch !== refresh.selectionEpoch) return;
			if (detail && (detail.ordinal !== exit.ordinal || detail.serverInstanceId !== snapshot.serverInstanceId
				|| detail.chatId !== chatId || detail.transcriptViewId !== snapshot.transcriptViewId)) throw new Error('Foreign plan detail');
			this.port.conversationUi.updatePendingPermissionsForChat(chatId, previous => [
				...previous.filter(request => !request.planReference),
				...(detail && planReference ? [{ permissionOccurrenceId: planOccurrenceId(snapshot.transcriptViewId, exit.ordinal),
					requestedTool: detail.message, chatId, receivedAt: new Date(exit.timestamp), planReference }] : []),
			]);
			refresh.loading = false;
			this.#publish(chatId, refresh);
		} catch (error) { this.#failed(chatId, refresh, error); }
	}
	async #move(chatId: string, refresh: PlanRefresh, direction: 1 | -1): Promise<void> {
		const snapshot = refresh.snapshot;
		if (!snapshot || refresh.loading || !this.#current(chatId, refresh)) return;
		const index = refresh.index + direction;
		if (index >= 0 && index < snapshot.exits.length) { refresh.index = index; return this.#select(chatId, refresh); }
		const afterOrdinal = direction === 1 ? snapshot.nextAfterOrdinal : refresh.before.at(-1);
		if (afterOrdinal === null || afterOrdinal === undefined) return;
		const before = direction === 1 ? [...refresh.before, refresh.request.afterOrdinal ?? 0] : refresh.before.slice(0, -1);
		const request = { ...refresh.request, afterOrdinal };
		refresh.pending = { request, before, index: direction === 1 ? 0 : -1 };
		refresh.loading = true;
		this.#publish(chatId, refresh);
		await this.#read(request, refresh);
	}
	#publish(chatId: string, refresh: PlanRefresh): void {
		const snapshot = refresh.snapshot;
		this.port.conversationUi.setPlanPresentation(chatId, {
			pendingExitCount: snapshot?.pendingExitCount ?? 0, loading: refresh.loading, updating: refresh.loading, stale: false, error: refresh.error,
			hasPrevious: refresh.index > 0 || refresh.before.length > 0,
			hasNext: !!snapshot && (refresh.index + 1 < snapshot.exits.length || snapshot.nextAfterOrdinal !== null),
			next: () => this.#move(chatId, refresh, 1), previous: () => this.#move(chatId, refresh, -1),
			retry: async () => {
				if (refresh.loading || !this.#current(chatId, refresh)) return;
				refresh.loading = true;
				refresh.error = null;
				this.#publish(chatId, refresh);
				if (refresh.metadataPending || refresh.pending || !refresh.snapshot) await this.#read(refresh.pending?.request ?? refresh.request, refresh);
				else await this.#select(chatId, refresh);
			},
		});
	}
	#failed(chatId: string, refresh: PlanRefresh, error: unknown): void {
		if (!this.#current(chatId, refresh)) return;
		refresh.revision = -1; refresh.loading = false;
		refresh.error = error instanceof Error ? error.message : 'Unable to refresh plan suggestions';
		this.#publish(chatId, refresh);
		this.port.onError(chatId, refresh.error);
	}
	#current(chatId: string, refresh: PlanRefresh): boolean {
		if (refresh.abort.signal.aborted || this.#chats.get(chatId) !== refresh) return false;
		if (this.port.isCurrent(refresh.request)) return true;
		refresh.abort.abort();
		this.#chats.delete(chatId);
		return false;
	}
}
