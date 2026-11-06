import {
	DISPLAY_BODY_LIMIT,
	DISPLAY_BYTE_BUDGET,
	displayCutsKey,
	displayProfileKey,
	sameDisplayCertificate,
	type AvailableDisplayWindow,
	type DisplayCertificate,
	type DisplayCut,
	type DisplayDescriptor,
	type DisplayProfile,
	type DisplayTargetResolution,
	type DisplayWindowRequest,
	type GroupDescriptor,
	type MemberWindowRequest,
	type MemberWindowResponse,
	type RowDetails,
	type RowDescriptor,
	type WindowAnchor,
} from '$shared/transcript-display-contract';
import type { DisplayOpenResponse, DisplayPreparationStatus } from '$shared/transcript-display-open';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { DisplayBodyStore } from './display-body-store.js';
import type { CoverageOutcome } from './display-coverage.js';
import type { TranscriptPageApplicationGate } from './transcript-page-progress.js';
import { ApiError } from '$lib/api/client.js';

export interface DisplayExpansion {
	readonly anchorOrdinal: number;
	readonly openedAt: number;
	readonly page: MemberWindowResponse;
}

export interface DisplayWindowSnapshot {
	readonly window: AvailableDisplayWindow | null;
	readonly expansions: readonly DisplayExpansion[];
	readonly details: ReadonlyMap<number, RowDetails>;
	readonly detailsCertificate: DisplayCertificate | null;
	readonly protectedRows: readonly ProtectedDisplayRow[];
	readonly phase: 'idle' | 'requesting' | 'available' | 'preparing' | 'lagging' | 'busy' | 'failed';
	readonly error: string | null;
	readonly revision: number;
}
export interface ProtectedDisplayRow {
	readonly certificate: DisplayCertificate;
	readonly detail: RowDetails;
	readonly layout: RowDescriptor['layout'];
}
type DisplayWindowOpen = Pick<DisplayOpenResponse, 'serverInstanceId' | 'transcriptViewId' | 'sourceHead' | 'display'>
	& { readonly chat: Pick<DisplayOpenResponse['chat'], 'id'> };
type DisplayNavigationResolution = DisplayTargetResolution | { kind: 'stale-view'; ordinal: number; landedOrdinal: null };

export const emptyDisplayWindow = (): DisplayWindowSnapshot => ({
	window: null, expansions: [], details: new Map(), detailsCertificate: null, protectedRows: [], phase: 'idle', error: null, revision: 0,
});

export function descriptorFirst(item: DisplayDescriptor): number {
	return item.kind === 'row' ? item.ordinal : item.firstMember;
}
export function descriptorLast(item: DisplayDescriptor): number {
	return item.kind === 'row' ? item.ordinal : item.lastMember;
}
function descriptorInterval(item: DisplayDescriptor): { after: number; through: number } {
	return item.kind === 'row' ? { after: item.ordinal - 1, through: item.ordinal } : item.fragment;
}
export function expansionFor(group: GroupDescriptor, expansions: readonly DisplayExpansion[]): DisplayExpansion | undefined {
	return expansions.find(expansion => expansion.anchorOrdinal > group.fragment.after && expansion.anchorOrdinal <= group.fragment.through);
}

function detailOrdinals(detail: RowDetails): number[] {
	return [detail.ordinal, detail.pairedUse, detail.pairedResult, detail.questionWrapper, detail.permissionTerminal]
		.filter((ordinal): ordinal is number => ordinal !== null);
}

export class DisplayWindowController {
	#snapshot = emptyDisplayWindow();
	#identity: Pick<DisplayOpenResponse, 'serverInstanceId' | 'transcriptViewId'> & { chatId: string; policyRevision: number } | null = null;
	#profile: DisplayProfile | null = null;
	#cuts: readonly DisplayCut[] = [];
	#head = 0;
	#epoch = 0;
	#request: Promise<CoverageOutcome> | null = null;
	#abort: AbortController | null = null;
	#refreshTimer: ReturnType<typeof setTimeout> | null = null;
	#refreshDue = 0;
	#refreshPending = false;
	#refreshGoal: number | null = null;
	#parked = false;
	#disposed = false;
	#anchor: number | null = null;
	#pinned = true;
	#readingAnchorHold: { ordinal: number } | null = null;
	#navigationAnchor: { anchor: number | null; pinned: boolean } | null = null;
	#navigationEpoch: number | null = null;
	#readinessRevision = 0;
	#wakeNavigation: (() => void) | null = null;
	#openedAt = 0;
	#protected = new Set<number>();
	#applicationGate: TranscriptPageApplicationGate | undefined;
	#errorCode: string | null = null;

	constructor(
		readonly bodies: DisplayBodyStore,
		private readonly publish: (snapshot: DisplayWindowSnapshot) => void,
		private readonly api: Pick<TranscriptDisplayApi, 'open' | 'window' | 'members' | 'bodies' | 'resolve' | 'retry'> = transcriptDisplayApi,
	) {}

	get snapshot(): DisplayWindowSnapshot { return this.#snapshot; }
	get sourceHead(): number { return this.#head; }
	get profile(): DisplayProfile | null { return this.#profile; }
	get cuts(): readonly DisplayCut[] { return this.#cuts; }
	get busy(): boolean { return this.#request !== null || this.#navigationEpoch !== null; }
	get parked(): boolean { return this.#parked; }
	get residency() {
		const usage = this.bodies.usage(this), descriptors = this.#snapshot.window?.items.length ?? 0;
		return { ...usage, descriptors, protectedRows: this.#snapshot.protectedRows.length,
			budgetException: usage.count > 500 || usage.bytes > 12 * 1024 * 1024 || descriptors > 512 };
	}
	setApplicationGate(gate: TranscriptPageApplicationGate | undefined): void { this.#applicationGate = gate; }

	installOpen(open: DisplayWindowOpen, profile: DisplayProfile): void {
		const identity = this.#identity;
		if (!identity || identity.chatId !== open.chat.id || identity.transcriptViewId !== open.transcriptViewId
			|| identity.serverInstanceId !== open.serverInstanceId) this.reset();
		this.bodies.resetInstance(open.serverInstanceId);
		this.#identity = { serverInstanceId: open.serverInstanceId, chatId: open.chat.id,
			transcriptViewId: open.transcriptViewId, policyRevision: open.display.policyRevision };
		this.#head = Math.max(this.#head, open.sourceHead);
		this.#parked = false;
		this.bodies.setParked(this, false);
		this.configure({ ...profile, bashRevision: open.display.bashRevision }, this.#cuts);
	}

	configure(profile: DisplayProfile, cuts: readonly DisplayCut[]): void {
		if (this.#profile && displayProfileKey(profile) === displayProfileKey(this.#profile)
			&& displayCutsKey(cuts) === displayCutsKey(this.#cuts)) return;
		this.#profile = profile;
		this.#cuts = cuts;
		this.cancel();
		if (cuts.length > 32) {
			this.#commit({ ...this.#snapshot, phase: 'failed', error: 'Too many pending transcript overlays. Pending requests remain available below.' });
			return;
		}
		this.#scheduleRefresh(0);
	}

	setReadingAnchor(ordinal: number | null, pinned: boolean): void {
		if (this.#readingAnchorHold || this.#navigationEpoch !== null) return;
		const resumedFollowing = pinned && !this.#pinned;
		this.#navigationAnchor = null;
		this.#anchor = ordinal;
		this.#pinned = pinned;
		if (resumedFollowing && this.#needsHeadRefresh()) this.#scheduleRefresh(0);
	}

	holdReadingAnchor(ordinal: number): () => void {
		const hold = { ordinal };
		this.#readingAnchorHold = hold;
		this.#anchor = ordinal;
		this.#pinned = false;
		return () => { if (this.#readingAnchorHold === hold) this.#readingAnchorHold = null; };
	}

	observeHead(transcriptViewId: string, head: number): void {
		if (!this.#identity || transcriptViewId !== this.#identity.transcriptViewId) return;
		this.#head = Math.max(this.#head, head);
		if (this.#needsHeadRefresh() || this.#needsDetailRefresh()) this.#scheduleRefresh(250);
	}

	ready(bashRevision?: string, phase: DisplayPreparationStatus['phase'] = 'available'): void {
		if (phase !== 'preparing') {
			this.#readinessRevision += 1;
			this.#wakeNavigation?.();
		}
		if (bashRevision && this.#profile && this.#profile.bashRevision !== bashRevision) {
			this.configure({ ...this.#profile, bashRevision }, this.#cuts);
			return;
		}
		if (phase === 'available' && (this.#snapshot.phase !== 'available' || this.#needsHeadRefresh() || this.#needsDetailRefresh())) this.#scheduleRefresh(0);
	}

	#needsReplace(): boolean {
		const certificate = this.#snapshot.window?.certificate;
		return !certificate || !!this.#profile && (certificate.profileKey !== displayProfileKey(this.#profile)
			|| certificate.cutsKey !== displayCutsKey(this.#cuts));
	}

	#needsDetailRefresh(): boolean {
		return this.#snapshot.window !== null && this.#head > (this.#snapshot.detailsCertificate?.watermark ?? -1);
	}

	#needsHeadRefresh(): boolean {
		const window = this.#snapshot.window;
		if (this.#pinned && window?.later.kind === 'more') return true;
		return this.#head > (window?.certificate.watermark ?? -1)
			&& (this.#pinned || !window || window.later.kind !== 'more');
	}

	async retry(): Promise<CoverageOutcome> {
		if (!this.#identity) return 'blocked';
		const epoch = this.#epoch;
		await this.api.retry(this.#identity);
		if (this.#request) await this.#request;
		if (epoch !== this.#epoch) return 'blocked';
		return this.refresh();
	}

	refresh(): Promise<CoverageOutcome> {
		if (this.#navigationEpoch !== null) return Promise.resolve('blocked');
		const anchor: WindowAnchor = this.#pinned || this.#anchor === null
			? { kind: 'newest' } : { kind: 'around', ordinal: this.#anchor };
		return this.#loadWindow(anchor, 'replace');
	}

	loadInitialWindow(): Promise<CoverageOutcome> {
		if (this.#navigationEpoch !== null) return Promise.resolve('blocked');
		return this.#loadWindow({ kind: 'around', ordinal: 1 }, 'replace', undefined, undefined, this.#head);
	}

	load(direction: 'earlier' | 'later', applicationGate?: TranscriptPageApplicationGate): Promise<CoverageOutcome> {
		if (this.#navigationEpoch !== null) return Promise.resolve('blocked');
		if (this.#needsReplace()) return this.refresh();
		const window = this.#snapshot.window;
		if (!window) return this.refresh();
		const edge = direction === 'earlier' ? window.earlier : window.later;
		if (edge.kind !== 'more') {
			if (direction === 'later' && window.certificate.watermark < this.#head) return this.refresh();
			return Promise.resolve('exhausted');
		}
		return this.#loadWindow({ kind: direction === 'earlier' ? 'before' : 'after', cursor: edge.cursor }, direction, applicationGate);
	}

	async navigate(ordinal: number, signal?: AbortSignal, ownsNavigation: () => boolean = () => true): Promise<DisplayNavigationResolution | null> {
		this.cancel();
		this.#readingAnchorHold = null;
		const epoch = this.#epoch;
		this.#navigationEpoch = epoch;
		const navigationAnchor = { anchor: this.#anchor, pinned: this.#pinned };
		let completed = false;
		const current = () => epoch === this.#epoch && !signal?.aborted && ownsNavigation();
		const gate: TranscriptPageApplicationGate = async () => {
			if (!current()) return 'invalidated';
			const result = await this.#applicationGate?.() ?? 'apply';
			return current() ? result : 'invalidated';
		};
		const abort = () => { if (epoch === this.#epoch) this.cancel(); };
		signal?.addEventListener('abort', abort, { once: true });
		try {
			if (!current()) return null;
			this.#navigationAnchor = navigationAnchor;
			this.#anchor = ordinal;
			this.#pinned = false;
			if (await this.#navigationRequest(() => this.#loadWindow({ kind: 'around', ordinal }, 'replace', gate, undefined, ordinal), current) !== 'loaded') {
				return this.#errorCode === 'STALE_TRANSCRIPT_VIEW' ? { kind: 'stale-view', ordinal, landedOrdinal: null } : null;
			}
			let window = this.#snapshot.window;
			const profile = this.#profile;
			if (!window || !profile || !current()) return null;
			const resolution = await this.api.resolve({ certificate: window.certificate, profile, cuts: this.#cuts, ordinal }, signal);
			if (!current()) return null;
			const landed = resolution.landedOrdinal;
			if (landed !== null && (resolution.kind === 'group-member' || resolution.kind === 'attached-detail' || resolution.kind === 'filtered')) {
				if (!window.items.some(item => landed >= descriptorFirst(item) && landed <= descriptorLast(item))) {
					const watermark = window.certificate.watermark;
					if (await this.#navigationRequest(() => this.#loadWindow({ kind: 'around', ordinal: landed }, 'replace', gate, watermark), current) !== 'loaded') return null;
					window = this.#snapshot.window!;
				}
				const group = window.items.find((item): item is GroupDescriptor => item.kind === 'tool-group'
					&& landed > item.fragment.after && landed <= item.fragment.through);
				if (group && await this.#navigationRequest(() => this.#loadMembers(group, { kind: 'around', ordinal: landed }, 'replace', gate), current) !== 'loaded') return null;
			}
			completed = current();
			if (completed && this.#navigationAnchor === navigationAnchor) this.#navigationAnchor = null;
			return completed ? resolution : null;
		} catch (error) {
			if (!current()) return null;
			if (error instanceof ApiError && error.errorCode === 'STALE_TRANSCRIPT_VIEW') return { kind: 'stale-view', ordinal, landedOrdinal: null };
			if (error instanceof ApiError && error.errorCode === 'DISPLAY_REVISION_CHANGED') {
				let changed: boolean;
				try { changed = await this.#reopenRevision(signal, epoch); }
				catch (reopenError) { if (!current()) return null; throw reopenError; }
				if (!current()) return null;
				if (changed) return this.navigate(ordinal, signal, ownsNavigation);
			}
			throw error;
		} finally {
			signal?.removeEventListener('abort', abort);
			if (this.#navigationEpoch === epoch) this.#navigationEpoch = null;
			if (!completed && epoch === this.#epoch) {
				this.cancel();
				if (['preparing', 'lagging', 'busy'].includes(this.#snapshot.phase)) {
					this.#commit({ ...this.#snapshot, phase: this.#snapshot.window ? 'available' : 'idle', error: null });
				}
			}
			if (completed && epoch === this.#epoch && this.#refreshPending) this.#scheduleRefresh(250);
		}
	}

	async #navigationRequest(request: () => Promise<CoverageOutcome>, current: () => boolean): Promise<CoverageOutcome> {
		while (current()) {
			const revision = this.#readinessRevision;
			const result = await request();
			if (!current() || result !== 'blocked' || !['preparing', 'lagging', 'busy'].includes(this.#snapshot.phase)) return result;
			if (revision !== this.#readinessRevision) continue;
			await new Promise<void>(resolve => {
				const wake = () => {
					clearTimeout(timer);
					if (this.#wakeNavigation === wake) this.#wakeNavigation = null;
					resolve();
				};
				const timer = setTimeout(wake, 1500);
				this.#wakeNavigation = wake;
			});
		}
		return 'blocked';
	}

	expand(group: GroupDescriptor, anchor: MemberWindowRequest['anchor'] = { kind: 'first' }): Promise<CoverageOutcome> {
		if (this.#navigationEpoch !== null) return Promise.resolve('blocked');
		return this.#loadMembers(group, anchor, 'replace');
	}

	extendMembers(group: GroupDescriptor, anchor: MemberWindowRequest['anchor']): Promise<CoverageOutcome> {
		if (this.#navigationEpoch !== null) return Promise.resolve('blocked');
		return this.#loadMembers(group, anchor, 'extend');
	}

	async #loadMembers(group: GroupDescriptor, anchor: MemberWindowRequest['anchor'], mode: 'replace' | 'extend', applicationGate?: TranscriptPageApplicationGate): Promise<CoverageOutcome> {
		const epoch = this.#epoch;
		if (this.#request) await this.#request;
		if (epoch !== this.#epoch) return 'blocked';
		if (this.#needsReplace() && await this.refresh() !== 'loaded') return 'blocked';
		if (epoch !== this.#epoch) return 'blocked';
		const anchorOrdinal = anchor.kind === 'first' ? group.firstMember : anchor.ordinal;
		const currentGroup = this.#snapshot.window?.items.find((item): item is GroupDescriptor => item.kind === 'tool-group'
			&& anchorOrdinal > item.fragment.after && anchorOrdinal <= item.fragment.through);
		if (!currentGroup) return 'blocked';
		group = currentGroup;
		return this.#run(async (signal, epoch) => {
			const window = this.#snapshot.window, profile = this.#profile;
			if (!window || !profile) return 'blocked';
			if (this.#needsReplace()) return 'blocked';
			let page = await this.api.members({ certificate: window.certificate, profile, cuts: this.#cuts,
				base: group.base, fragment: group.fragment, anchor, limit: 50 }, signal);
			this.#assertCertificate(page.certificate, window.certificate);
			const prior = expansionFor(group, this.#snapshot.expansions);
			if (mode === 'extend' && prior) {
				const earlier = anchor.kind === 'before';
				page = { ...page, ordinals: [...new Set([...prior.page.ordinals, ...page.ordinals])].sort((a, b) => a - b),
					earlier: earlier ? page.earlier : prior.page.earlier, later: earlier ? prior.page.later : page.later };
			}
			const others = this.#snapshot.expansions.filter(expansion => expansionFor(group, [expansion]) === undefined);
			let anchorOrdinal: number | undefined = page.ordinals[0];
			if (anchor.kind === 'before') anchorOrdinal = page.ordinals.at(-1);
			else if (anchor.kind === 'around' && page.ordinals.includes(anchor.ordinal)) anchorOrdinal = anchor.ordinal;
			if (anchorOrdinal === undefined) return 'exhausted';
			const expansions = [...others, { anchorOrdinal, openedAt: ++this.#openedAt, page }];
			await this.#hydrateAndApply(window, expansions, signal, epoch, applicationGate);
			return 'loaded';
		});
	}

	collapse(group: GroupDescriptor): void {
		this.cancel();
		const expansions = this.#snapshot.expansions.filter(expansion => !expansionFor(group, [expansion]));
		const details = this.#retainedDetails(this.#snapshot.window, expansions);
		const protectedRows = this.#captureProtectedRows(new Set(details.keys()));
		this.#commit({ ...this.#snapshot, expansions, protectedRows, details });
		this.#retainBodies();
		if (this.#needsReplace() || this.#needsHeadRefresh() || this.#needsDetailRefresh()) this.#scheduleRefresh(250);
	}

	protect(ordinals: readonly number[]): void {
		this.#protected = new Set(ordinals);
		const protectedRows = this.#snapshot.protectedRows.filter(row => this.#protected.has(row.detail.ordinal));
		if (protectedRows.length !== this.#snapshot.protectedRows.length) {
			this.#commit({ ...this.#snapshot, protectedRows });
			this.#retainBodies();
		}
	}

	trim(firstOrdinal: number, lastOrdinal: number, visibleRowOrdinals: readonly number[] = [firstOrdinal, lastOrdinal]): void {
		const window = this.#snapshot.window;
		if (!window || this.busy || this.#readingAnchorHold) return;
		const keep = window.items.map((item, index) => ({ item, index })).filter(({ item }) =>
			descriptorLast(item) >= firstOrdinal && descriptorFirst(item) <= lastOrdinal);
		if (keep.length === 0) return;
		const pressured = this.bodies.activeOverBudget || this.residency.budgetException;
		const margin = pressured ? 0 : 10;
		const start = Math.max(0, keep[0].index - margin);
		// Following retains the tail even while native scrolling defers end restoration.
		const end = this.#pinned ? window.items.length : Math.min(window.items.length, keep.at(-1)!.index + margin + 1);
		const items = window.items.slice(start, end);
		const after = descriptorInterval(items[0]).after, through = descriptorInterval(items.at(-1)!).through;
		const next: AvailableDisplayWindow = { ...window, items, interval: { after, through },
			earlier: start === 0 ? window.earlier : { kind: 'more', cursor: { certificate: window.certificate, boundaryOrdinal: after + 1 } },
			later: end === window.items.length ? window.later : { kind: 'more', cursor: { certificate: window.certificate, boundaryOrdinal: through } },
			cutPlacements: window.cutPlacements.map(cut => ({ ...cut, placement: this.#cuts.some(anchor => anchor.id === cut.id
				&& anchor.afterOrdinal >= after && anchor.afterOrdinal <= through) ? cut.placement : 'detached' })) };
		const expansions = this.#snapshot.expansions.filter(expansion => items.some(item => item.kind === 'tool-group' && expansionFor(item, [expansion])))
			.map(expansion => this.#trimMembers(expansion, visibleRowOrdinals, pressured));
		if (start === 0 && end === window.items.length && expansions.every((expansion, index) => expansion === this.#snapshot.expansions[index])) return;
		const details = this.#retainedDetails(next, expansions);
		const protectedRows = this.#captureProtectedRows(new Set(details.keys()));
		this.#commit({ ...this.#snapshot, window: next, expansions, protectedRows, details });
		this.#retainBodies();
	}

	#trimMembers(expansion: DisplayExpansion, visibleRowOrdinals: readonly number[], pressured: boolean): DisplayExpansion {
		const page = expansion.page, ordinals = page.ordinals;
		if (!pressured && ordinals.length <= 100) return expansion;
		const visible = visibleRowOrdinals.filter(ordinal => ordinals.includes(ordinal));
		const first = visible.length ? Math.min(...visible) : expansion.anchorOrdinal;
		const last = visible.length ? Math.max(...visible) : expansion.anchorOrdinal;
		const index = ordinals.findIndex(ordinal => ordinal >= first);
		const margin = pressured ? 0 : 25;
		const start = Math.max(0, (index < 0 ? ordinals.length - 1 : index) - margin);
		const lastIndex = ordinals.findLastIndex(ordinal => ordinal <= last);
		const end = Math.min(ordinals.length, Math.max(start + (pressured ? 1 : 50), lastIndex + margin + 1));
		if (start === 0 && end === ordinals.length) return expansion;
		const retained = ordinals.slice(start, end);
		return { ...expansion, anchorOrdinal: Math.max(retained[0], Math.min(retained.at(-1)!, expansion.anchorOrdinal)),
			page: { ...page, ordinals: retained,
				earlier: start ? { beforeOrdinal: retained[0], remaining: (page.earlier?.remaining ?? 0) + start } : page.earlier,
				later: end < ordinals.length ? { afterOrdinal: retained.at(-1)!, remaining: (page.later?.remaining ?? 0) + ordinals.length - end } : page.later } };
	}

	#loadWindow(anchor: WindowAnchor, mode: 'replace' | 'earlier' | 'later' | 'details', applicationGate?: TranscriptPageApplicationGate, atWatermark?: number, requiredThrough?: number): Promise<CoverageOutcome> {
		return this.#run(async (signal, epoch) => {
			const identity = this.#identity, profile = this.#profile, cuts = this.#cuts;
			if (!identity || !profile) return 'blocked';
			const fresh = mode === 'replace' || mode === 'details';
			let goal = this.#head;
			if (requiredThrough !== undefined) goal = requiredThrough;
			else if (fresh) {
				this.#refreshGoal ??= this.#head;
				goal = this.#refreshGoal;
			}
			let watermarkRequest: Pick<DisplayWindowRequest, 'atWatermark' | 'requiredThrough'> = {};
			if (atWatermark !== undefined) watermarkRequest = { atWatermark };
			else if (fresh) watermarkRequest = { requiredThrough: goal };
			const response = await this.api.window({ ...identity, profile, cuts, anchor, limit: mode === 'details' ? 1 : 50,
				...watermarkRequest }, signal);
			this.#assertCurrent(signal, epoch);
			if (response.kind !== 'available') {
				if (response.chatId !== identity.chatId || response.transcriptViewId !== identity.transcriptViewId
					|| response.serverInstanceId !== identity.serverInstanceId || response.profileKey !== displayProfileKey(profile)) throw new Error('Foreign display status');
				this.#commit({ ...this.#snapshot, phase: mode === 'details' && response.kind !== 'failed' ? 'available' : response.kind,
					error: response.kind === 'failed' ? response.errorCode : null });
				if (response.kind !== 'failed') this.#scheduleRefresh(Math.max(1000, response.retryAfterMs ?? 1500));
				return response.kind === 'failed' ? 'failed' : 'blocked';
			}
			this.#assertIdentity(response.certificate);
			this.#head = Math.max(this.#head, response.sourceHead);
			const anchoredRefresh = mode === 'replace' && anchor.kind === 'around' && requiredThrough === undefined && atWatermark === undefined;
			const assertReadingIntent = (expansions?: readonly DisplayExpansion[]) => {
				if (!anchoredRefresh) return;
				const ordinal = this.#anchor;
				const moved = expansions && ordinal !== null && ordinal !== anchor.ordinal;
				const wasMember = moved && this.#snapshot.expansions.some(expansion => expansion.page.ordinals.includes(ordinal));
				const represented = !moved || response.items.some(item => item.kind === 'row' ? item.ordinal === ordinal
					: ordinal >= item.firstMember && ordinal <= item.lastMember
						&& (!wasMember || expansions.some(expansion => expansion.page.ordinals.includes(ordinal))));
				if (this.#pinned || !represented) {
					this.#scheduleRefresh(0);
					throw new DOMException('Display reading intent changed', 'AbortError');
				}
			};
			assertReadingIntent();
			if (mode === 'details') {
				const current = this.#snapshot;
				if (!current.window) return 'blocked';
				await this.#hydrateAndApply(current.window, current.expansions, signal, epoch, applicationGate, response.certificate);
				this.#refreshGoal = null;
				if (this.#needsDetailRefresh()) this.#scheduleRefresh(250);
				return 'loaded';
			}
			let window = response;
			const previous = this.#snapshot.window;
			if (mode !== 'replace' && previous) {
				this.#assertCertificate(previous.certificate, response.certificate);
				const earlier = mode === 'earlier' ? response : previous, later = mode === 'earlier' ? previous : response;
				if (earlier.interval.through > later.interval.after) throw new Error('Overlapping display pages');
				window = { ...response, items: [...earlier.items, ...later.items], earlier: earlier.earlier, later: later.later,
					interval: { after: earlier.interval.after, through: later.interval.through },
					cutPlacements: response.cutPlacements.map(cut => ({ ...cut, placement: cut.placement === 'inline'
						|| previous.cutPlacements.some(old => old.id === cut.id && old.placement === 'inline') ? 'inline' : 'detached' })) };
			}
			const expansions = mode === 'replace' ? await this.#remapExpansions(window, signal) : this.#snapshot.expansions;
			await this.#hydrateAndApply(window, expansions, signal, epoch, applicationGate, window.certificate, () => assertReadingIntent(expansions));
			if (mode === 'replace') this.#refreshGoal = null;
			if (this.#needsHeadRefresh()) this.#scheduleRefresh(250);
			return 'loaded';
		}, mode === 'details' ? 'details' : 'foreground');
	}

	async #remapExpansions(window: AvailableDisplayWindow, signal: AbortSignal): Promise<DisplayExpansion[]> {
		const profile = this.#profile;
		if (!profile?.combine) return [];
		const intents = this.#snapshot.expansions.map(expansion => this.#anchor !== null && expansion.page.ordinals.includes(this.#anchor)
			? { ...expansion, anchorOrdinal: this.#anchor } : expansion);
		const remapped: DisplayExpansion[] = [];
		for (const group of window.items) {
			if (group.kind !== 'tool-group') continue;
			const candidates = intents.filter(expansion => expansionFor(group, [expansion])
				|| (expansion.page.base.afterBreaker < group.lastMember && expansion.page.base.beforeBreaker > group.firstMember));
			candidates.sort((a, b) => Number(b.page.ordinals.some(o => this.#protected.has(o))) - Number(a.page.ordinals.some(o => this.#protected.has(o)))
				|| Number(b.anchorOrdinal === this.#anchor) - Number(a.anchorOrdinal === this.#anchor) || b.openedAt - a.openedAt);
			const intent = candidates.find(candidate => !remapped.some(accepted => accepted.openedAt === candidate.openedAt));
			if (!intent) continue;
			// A split follows its anchor; a filter may move that anchor to a surviving member.
			const containing = window.items.some(item => item.kind === 'tool-group' && expansionFor(item, [intent]));
			if (containing && !expansionFor(group, [intent])) continue;
			const ordinal = Math.max(group.firstMember, Math.min(group.lastMember, intent.anchorOrdinal));
			const page = await this.api.members({ certificate: window.certificate, profile, cuts: this.#cuts,
				base: group.base, fragment: group.fragment, anchor: { kind: 'around', ordinal }, limit: 50 }, signal);
			this.#assertCertificate(page.certificate, window.certificate);
			if (page.ordinals.length) remapped.push({ ...intent, anchorOrdinal: ordinal, page });
		}
		return remapped;
	}

	#seeds(window: AvailableDisplayWindow | null, expansions: readonly DisplayExpansion[]): number[] {
		return [...(window?.items.flatMap(item => item.kind === 'row' ? [item.ordinal] : []) ?? []),
			...expansions.flatMap(expansion => expansion.page.ordinals)];
	}

	#retainedDetails(window: AvailableDisplayWindow | null, expansions: readonly DisplayExpansion[]): Map<number, RowDetails> {
		const seeds = new Set(this.#seeds(window, expansions));
		return new Map([...this.#snapshot.details].filter(([ordinal]) => seeds.has(ordinal)));
	}

	async #hydrateAndApply(window: AvailableDisplayWindow, expansions: readonly DisplayExpansion[], signal: AbortSignal, epoch: number, applicationGate?: TranscriptPageApplicationGate, detailsCertificate = window.certificate, assertApplication?: () => void): Promise<void> {
		const profile = this.#profile!;
		const previousCertificate = this.#snapshot.detailsCertificate;
		if (previousCertificate && previousCertificate.watermark > detailsCertificate.watermark
			&& sameDisplayCertificate({ ...previousCertificate, watermark: detailsCertificate.watermark }, detailsCertificate)) detailsCertificate = previousCertificate;
		const represented = new Set(this.#seeds(window, expansions));
		const protectedRows = this.#captureProtectedRows(represented);
		const seeds = [...represented, ...protectedRows.map(row => row.detail.ordinal)].filter(ordinal => ordinal <= detailsCertificate.watermark);
		const staged = {};
		const retained = new Set([...seeds, ...[...this.#snapshot.details.values(), ...protectedRows.map(row => row.detail)].flatMap(detailOrdinals)]);
		const details = new Map<number, RowDetails>();
		this.bodies.retain(staged, detailsCertificate, retained);
		try {
			for (let offset = 0; offset < seeds.length; offset += 50) {
				const seedOrdinals = seeds.slice(offset, offset + 50);
				let previousDeferred = Infinity;
				for (;;) {
					this.#assertCurrent(signal, epoch);
					const response = await this.api.bodies({ certificate: detailsCertificate, profile, cuts: this.#cuts,
						seedOrdinals, residentOrdinals: this.bodies.residentOrdinals(detailsCertificate, retained).filter(ordinal => ordinal <= detailsCertificate.watermark).slice(-2000),
						limitBodies: DISPLAY_BODY_LIMIT, estimatedByteBudget: DISPLAY_BYTE_BUDGET }, signal);
					this.#assertCurrent(signal, epoch);
					this.#assertCertificate(response.certificate, detailsCertificate);
					for (const detail of response.details) {
						details.set(detail.ordinal, detail);
						for (const ordinal of detailOrdinals(detail)) retained.add(ordinal);
					}
					this.bodies.put(detailsCertificate, response.bodies);
					this.bodies.retain(staged, detailsCertificate, retained);
					if (response.nonRenderedOrdinals.some(ordinal => seedOrdinals.includes(ordinal))) throw new Error('Display seed is not renderable');
					if (!response.deferredOrdinals.length) break;
					if (response.deferredOrdinals.length >= previousDeferred) throw new Error('Display hydration made no progress');
					previousDeferred = response.deferredOrdinals.length;
				}
			}
			const gate = applicationGate ?? this.#applicationGate;
			if (gate && await gate() !== 'apply') throw new DOMException('Display application cancelled', 'AbortError');
			this.#assertCurrent(signal, epoch);
			assertApplication?.();
			const refreshedProtected = this.#captureProtectedRows(represented).map(row => {
				const detail = details.get(row.detail.ordinal);
				return detail ? { ...row, certificate: detailsCertificate, detail } : row;
			});
			for (const row of protectedRows) details.delete(row.detail.ordinal);
			this.#commit({ window, expansions, details, detailsCertificate, protectedRows: refreshedProtected, phase: 'available', error: null, revision: this.#snapshot.revision });
			this.#retainBodies();
		} finally { this.bodies.release(staged); }
	}

	#captureProtectedRows(represented: ReadonlySet<number>): ProtectedDisplayRow[] {
		const window = this.#snapshot.window;
		if (!window) return [];
		const rows = new Map(this.#snapshot.protectedRows.filter(row => this.#protected.has(row.detail.ordinal)).map(row => [row.detail.ordinal, row]));
		for (const ordinal of this.#protected) {
			const detail = this.#snapshot.details.get(ordinal);
			if (!detail || rows.has(ordinal)) continue;
			const descriptor = window.items.find(item => item.kind === 'row' && item.ordinal === ordinal);
			rows.set(ordinal, { certificate: this.#snapshot.detailsCertificate ?? window.certificate, detail, layout: descriptor?.kind === 'row' ? descriptor.layout : 'standard' });
		}
		return [...rows.values()].filter(row => !represented.has(row.detail.ordinal));
	}

	#retainBodies(): void {
		const window = this.#snapshot.window;
		if (!window) { this.bodies.release(this); return; }
		this.bodies.retain(this, window.certificate, [...this.#snapshot.details.values(), ...this.#snapshot.protectedRows.map(row => row.detail)].flatMap(detailOrdinals));
	}

	#assertCurrent(signal: AbortSignal | undefined, epoch: number): void {
		signal?.throwIfAborted();
		if (epoch !== this.#epoch || this.#disposed) throw new DOMException('Display request superseded', 'AbortError');
	}

	async #reopenRevision(signal: AbortSignal | undefined, epoch: number): Promise<boolean> {
		const identity = this.#identity!;
		const open = await this.api.open({ chatId: identity.chatId, expectedTranscriptViewId: identity.transcriptViewId,
			reason: 'reconnect', outstandingClientMessageIds: [] }, signal);
		this.#assertCurrent(signal, epoch);
		if (open.serverInstanceId !== identity.serverInstanceId || open.transcriptViewId !== identity.transcriptViewId
			|| open.chat.id !== identity.chatId || open.display.policyRevision !== identity.policyRevision) throw new Error('Foreign display open');
		this.#head = Math.max(this.#head, open.sourceHead);
		if (this.#profile!.bashRevision === open.display.bashRevision) return false;
		this.#profile = { ...this.#profile!, bashRevision: open.display.bashRevision };
		this.#refreshGoal = null;
		this.#readinessRevision++;
		return true;
	}

	#assertIdentity(certificate: DisplayCertificate): void {
		const identity = this.#identity;
		if (!identity || certificate.serverInstanceId !== identity.serverInstanceId || certificate.chatId !== identity.chatId
			|| certificate.transcriptViewId !== identity.transcriptViewId || certificate.policyRevision !== identity.policyRevision
			|| !this.#profile || certificate.profileKey !== displayProfileKey(this.#profile) || certificate.cutsKey !== displayCutsKey(this.#cuts)) throw new Error('Foreign display certificate');
	}

	#assertCertificate(actual: DisplayCertificate, expected: DisplayCertificate): void {
		if (!sameDisplayCertificate(actual, expected)) throw new Error('Mismatched display certificate');
	}

	#commit(snapshot: DisplayWindowSnapshot): void {
		this.#snapshot = { ...snapshot, revision: this.#snapshot.revision + 1 };
		this.publish(this.#snapshot);
	}

	#run(work: (signal: AbortSignal, epoch: number) => Promise<CoverageOutcome>, mode: 'foreground' | 'details' = 'foreground'): Promise<CoverageOutcome> {
		if (this.#parked || this.#disposed || !this.#identity) return Promise.resolve('blocked');
		if (this.#request) return Promise.resolve('blocked');
		const epoch = this.#epoch, abort = new AbortController();
		this.#errorCode = null;
		this.#abort = abort;
		this.#commit({ ...this.#snapshot, phase: mode === 'details' ? 'available' : 'requesting', error: null });
		const request = work(abort.signal, epoch).catch(async (error: unknown): Promise<CoverageOutcome> => {
			if (abort.signal.aborted || epoch !== this.#epoch || error instanceof DOMException && error.name === 'AbortError') return 'blocked';
			if (error instanceof ApiError && error.errorCode === 'DISPLAY_REVISION_CHANGED') {
				try {
					const changed = await this.#reopenRevision(abort.signal, epoch);
					this.#commit({ ...this.#snapshot, phase: 'busy', error: null });
					this.#scheduleRefresh(changed ? 0 : 1500);
					return 'blocked';
				} catch (reopenError) { error = reopenError; }
				if (abort.signal.aborted || epoch !== this.#epoch || error instanceof DOMException && error.name === 'AbortError') return 'blocked';
			}
			this.#errorCode = error instanceof ApiError ? error.errorCode ?? null : null;
			if (error instanceof ApiError && ['DISPLAY_BUSY', 'DISPLAY_TIMEOUT', 'DISPLAY_UNAVAILABLE', 'DISPLAY_PREPARING', 'DISPLAY_SUPERSEDED'].includes(error.errorCode ?? '')) {
				this.#commit({ ...this.#snapshot, phase: mode === 'details' ? 'available' : 'busy', error: null });
				this.#scheduleRefresh(1500);
				return 'blocked';
			}
			this.#commit({ ...this.#snapshot, phase: 'failed', error: error instanceof Error ? error.message : 'Display request failed' });
			return 'failed';
		}).finally(() => {
			if (this.#request !== request) return;
			this.#request = null;
			this.#abort = null;
			if (epoch === this.#epoch) {
				let phase = this.#snapshot.phase;
				if (phase === 'requesting') phase = this.#snapshot.window ? 'available' : 'idle';
				this.#commit({ ...this.#snapshot, phase });
			}
			if (this.#refreshTimer === null && (this.#refreshPending || this.#snapshot.phase === 'available'
				&& (this.#needsReplace() || this.#needsHeadRefresh() || this.#needsDetailRefresh()))) this.#scheduleRefresh(250);
		});
		this.#request = request;
		return request;
	}

	#scheduleRefresh(delay: number): void {
		this.#refreshPending = true;
		if (this.#parked || this.#disposed || this.#navigationEpoch !== null) return;
		const due = Date.now() + delay;
		if (this.#refreshTimer !== null) {
			if (this.#refreshDue <= due) return;
			clearTimeout(this.#refreshTimer);
		}
		this.#refreshDue = due;
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = null;
			if (this.#request || this.#navigationEpoch !== null) return;
			this.#refreshPending = false;
			if (this.#snapshot.phase === 'available' && !this.#needsReplace() && !this.#needsHeadRefresh() && !this.#needsDetailRefresh()) return;
			void (this.#needsReplace() || this.#needsHeadRefresh() || this.#snapshot.phase === 'failed'
				? this.refresh() : this.#loadWindow({ kind: 'newest' }, 'details'));
		}, delay);
	}

	cancel(): void {
		this.#epoch += 1;
		this.#navigationEpoch = null;
		this.#wakeNavigation?.();
		if (this.#navigationAnchor) {
			this.#anchor = this.#navigationAnchor.anchor;
			this.#pinned = this.#navigationAnchor.pinned;
			this.#navigationAnchor = null;
		}
		this.#abort?.abort();
		this.#request = null;
		this.#abort = null;
		if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
		this.#refreshTimer = null;
		this.#refreshPending = false;
		this.#refreshGoal = null;
		if (this.#snapshot.phase === 'requesting') this.#commit({ ...this.#snapshot, phase: this.#snapshot.window ? 'available' : 'idle', error: null });
	}

	park(): void { this.cancel(); this.#readingAnchorHold = null; this.#applicationGate = undefined; this.#parked = true; this.bodies.setParked(this, true); }
	activate(): void { this.#parked = false; this.bodies.setParked(this, false); this.#scheduleRefresh(0); }
	reset(): void {
		this.cancel();
		this.#readingAnchorHold = null;
		this.#identity = null;
		this.#profile = null;
		this.#cuts = [];
		this.#head = 0;
		this.#anchor = null;
		this.#pinned = true;
		this.#protected.clear();
		this.bodies.release(this);
		this.#commit(emptyDisplayWindow());
	}
	dispose(): void { this.reset(); this.#applicationGate = undefined; this.#disposed = true; }
}
