import { VirtualListGeometry } from './virtual-list-geometry';
import type { VirtualListEnvironment } from './virtual-list-environment';
import {
	applyVirtualCorrection,
	SETTLED_VIRTUAL_DEVIATION,
	type VirtualDeviationState,
} from './virtual-scroll-deviation';
import type {
	VirtualCorrectionProvenance,
	VirtualIndexScrollResult,
	VirtualItemsMutation,
	VirtualKeyScrollResult,
	LogicalVirtualItem,
	VirtualListSnapshot,
	VirtualMutationAnchor,
	VirtualMutationResult,
	VirtualRange,
	VirtualResumeResult,
	VirtualResumeTarget,
	VirtualScrollActivity,
	VirtualScrollResult,
	VirtualTransactionRecord,
	VirtualTransactionSource,
	VirtualViewportPosition,
} from './virtual-list-types';
import type {
	VirtualDomGeometry,
	VirtualElementMeasurement,
	VirtualListDomDriver,
} from './virtual-list-dom-driver';

type PendingTarget =
	| { kind: 'relative'; offset: number; leadingOffset: number }
	| { kind: 'logical'; offset: number }
	| { kind: 'end' };
interface PendingCommit {
	revision: number;
	source: VirtualTransactionSource;
	provenance: VirtualCorrectionProvenance;
	target: PendingTarget;
	barriers: number;
	restoreDeviation: VirtualDeviationState | null;
	record: MutableTransactionRecord;
}
type MutableTransactionRecord = {
	-readonly [Key in keyof VirtualTransactionRecord]: VirtualTransactionRecord[Key];
};
type CapturedAnchor =
	{ kind: 'item'; key: string; index: number; start: number } | { kind: 'end' } | { kind: 'none' };

export interface VirtualListTransactionOptions {
	readonly environment: VirtualListEnvironment;
	getOverscan(): number;
	getMeasurementAnchor(): 'geometric' | 'end';
	publish(snapshot: VirtualListSnapshot): void;
	onTransaction?(record: VirtualTransactionRecord): void;
}

export class VirtualListTransaction {
	readonly geometry = new VirtualListGeometry();

	#driver: VirtualListDomDriver | null = null;
	#snapshot: VirtualListSnapshot;
	#deviation: VirtualDeviationState = SETTLED_VIRTUAL_DEVIATION;
	#activity: VirtualScrollActivity = 'idle';
	#lastDom: VirtualDomGeometry | null = null;
	#lastLogicalOffset = 0;
	#pendingCommit: PendingCommit | null = null;
	#commitQueued = false;
	#viewportQueued = false;
	#deviationTimer: number | null = null;
	#ownedEpoch = 0;
	#ownedFrame: number | null = null;
	#ownsScrollPosition = false;
	#replacementPending = false;
	#suspended = false;
	#destroyed = false;
	#revision = 0;
	#publishedGeometryRevision = -1;
	#publishedDeviation = Number.NaN;

	constructor(private readonly options: VirtualListTransactionOptions) {
		this.#snapshot = {
			revision: 0,
			visibleRange: null,
			overscanRange: null,
			sizerSize: 0,
			positions: this.geometry.positionView(),
		};
	}

	get snapshot(): VirtualListSnapshot {
		return this.#snapshot;
	}
	get ownsScroll(): boolean {
		return this.#ownsScrollPosition;
	}
	get viewportPosition(): VirtualViewportPosition | null {
		const dom = this.#driver?.read();
		if (!dom || this.#suspended || this.#replacementPending) return null;
		const paintedOffset = dom.scrollTop - dom.leadingOffset;
		const logicalOffset = paintedOffset + this.#deviation.value;
		return {
			paintedOffset,
			logicalOffset,
			distanceFromStart: Math.max(0, logicalOffset),
			leadingContentReachable: dom.leadingOffset >= this.#deviation.value,
		};
	}
	attachDriver(driver: VirtualListDomDriver): void {
		this.#driver = driver;
	}

	apply(mutation: VirtualItemsMutation): VirtualMutationResult {
		const rejection = validateMutation(mutation, this.geometry);
		if (rejection) {
			const record = this.#record(
				mutation.kind === 'replace-surface' ? 'replace-surface' : 'items',
				null,
				mutation.kind === 'replace-surface' ? { kind: 'none' } : mutation.anchor,
				this.#lastDom,
				this.options.environment.now(),
			);
			record.rejectionReason = rejection.reason;
			this.#emitRecord(record);
			return rejection;
		}
		const dom = this.#driver?.read() ?? this.#lastDom;
		const started = this.options.environment.now();

		if (mutation.kind === 'replace-surface') {
			this.cancelOwnedScroll();
			this.geometry.replaceItems(mutation.keys, mutation.estimates);
			this.#driver?.clearItems();
			this.#setDeviation(SETTLED_VIRTUAL_DEVIATION);
			this.#replacementPending = true;
			this.#lastLogicalOffset = 0;
			this.#publish(dom, true, true);
			this.#emitRecord(this.#record('replace-surface', null, { kind: 'none' }, dom, started));
			return { kind: 'applied' };
		}

		const oldLeading = this.#lastDom?.leadingOffset ?? dom?.leadingOffset ?? 0;
		const oldTotal = this.geometry.totalSize();
		const anchor = this.#captureMutationAnchor(mutation.anchor);
		if (mutation.kind === 'reset-measurements') this.geometry.resetMeasurements();
		this.geometry.setItems(mutation.keys, mutation.estimates);
		this.#driver?.pruneKeys((key) => this.geometry.indexOf(key) !== undefined);
		if (this.#suspended) return { kind: 'applied' };

		const leadingDelta = (dom?.leadingOffset ?? oldLeading) - oldLeading;
		let correction = leadingDelta;
		if (anchor.kind === 'item') {
			const next = this.geometry.item(this.geometry.indexOf(anchor.key) ?? -1);
			correction += next ? next.start - anchor.start : -leadingDelta;
		} else if (anchor.kind === 'end') {
			correction += this.geometry.totalSize() - oldTotal;
		} else {
			correction = 0;
		}

		const provenance = anchor.kind === 'end' ? 'follow' : 'measurement';
		this.#applyCorrection({
			source: 'items',
			provenance,
			anchor: mutation.anchor,
			anchorIndex: anchor.kind === 'item' ? anchor.index : null,
			anchorStart: anchor.kind === 'item' ? anchor.start - this.#deviation.value : null,
			correction,
			dom,
			started,
			followEnd: anchor.kind === 'end',
		});
		return { kind: 'applied' };
	}

	measure(measurements: readonly VirtualElementMeasurement[], source: 'mount' | 'resize'): void {
		if (this.#destroyed || this.#suspended || measurements.length === 0) return;
		const accepted = measurements.filter(
			(measurement) =>
				Number.isFinite(measurement.size) &&
				measurement.size >= 0 &&
				this.geometry.indexOf(measurement.key) !== undefined,
		);
		this.#driver?.recordIgnoredEntries(measurements.length - accepted.length);
		if (accepted.length === 0) return;
		const dom = this.#driver?.read() ?? this.#lastDom;
		const started = this.options.environment.now();
		const oldTotal = this.geometry.totalSize();
		const firstMeasurements = new Set<string>();
		for (const measurement of accepted) {
			if (this.geometry.measuredSize(measurement.key) === undefined) {
				firstMeasurements.add(measurement.key);
			}
		}
		if (this.#replacementPending) {
			this.geometry.measureMany(accepted);
			return;
		}
		const anchor = this.#captureMeasurementAnchor(dom, firstMeasurements);
		this.geometry.measureMany(accepted);
		const correction =
			anchor.kind === 'end'
				? this.geometry.totalSize() - oldTotal
				: anchor.kind === 'item'
					? (this.geometry.item(this.geometry.indexOf(anchor.key) ?? -1)?.start ?? anchor.start) -
						anchor.start
					: 0;
		this.#applyCorrection({
			source,
			provenance: anchor.kind === 'end' ? 'follow' : 'measurement',
			anchor: anchor.kind === 'item' ? { kind: 'item', key: anchor.key } : anchor,
			anchorIndex: anchor.kind === 'item' ? anchor.index : null,
			anchorStart: anchor.kind === 'item' ? anchor.start - this.#deviation.value : null,
			correction,
			dom,
			started,
			followEnd: anchor.kind === 'end',
		});
	}

	viewportChanged(boundsChanged: boolean): void {
		if (this.#destroyed || this.#suspended || this.#replacementPending) return;
		const dom = this.#driver?.read();
		if (!dom) return;
		const yieldedCommit = this.#pendingCommit;
		if (yieldedCommit && !this.#commitQueued && yieldedCommit.barriers >= 2) {
			if (yieldedCommit.target.kind === 'relative') {
				yieldedCommit.target.offset += dom.leadingOffset - yieldedCommit.target.leadingOffset;
				yieldedCommit.target.leadingOffset = dom.leadingOffset;
			}
			yieldedCommit.barriers = 0;
			yieldedCommit.record.durationMs = -this.options.environment.now();
			this.#publish(dom, true, false, this.#logicalOffsetForTarget(yieldedCommit.target, dom));
			yieldedCommit.revision = this.#snapshot.revision;
			this.#queueCommit(yieldedCommit);
			return;
		}
		const started = this.options.environment.now();
		if (!this.#lastDom) {
			this.#lastDom = dom;
			this.#lastLogicalOffset = dom.scrollTop - dom.leadingOffset + this.#deviation.value;
			this.#publish(dom, true);
			return;
		}

		let correction = dom.leadingOffset - this.#lastDom.leadingOffset;
		let clampedRemainder = 0;
		if (boundsChanged && this.#deviation.value !== 0 && dom.scrollTop !== this.#lastDom.scrollTop) {
			const logicalMaximum = Math.max(0, this.geometry.totalSize() - dom.viewportSize);
			const desired = clamp(this.#lastLogicalOffset, 0, logicalMaximum);
			const solvedDeviation = desired - (dom.scrollTop - dom.leadingOffset);
			correction = solvedDeviation - this.#deviation.value;
			clampedRemainder = this.#lastLogicalOffset - desired;
		}

		const anchor = this.#captureMeasurementAnchor(this.#lastDom);
		this.#applyCorrection({
			source: 'viewport',
			provenance: anchor.kind === 'end' ? 'follow' : 'measurement',
			anchor: anchor.kind === 'item' ? { kind: 'item', key: anchor.key } : anchor,
			anchorIndex: anchor.kind === 'item' ? anchor.index : null,
			anchorStart: anchor.kind === 'item' ? anchor.start - this.#deviation.value : null,
			correction,
			dom,
			started,
			followEnd: anchor.kind === 'end',
			clampedRemainder,
		});
	}

	scrolled(): void {
		if (this.#destroyed || this.#suspended || this.#replacementPending) return;
		const dom = this.#driver?.read();
		if (!dom) return;
		const previous = this.#lastDom;
		const boundsChanged =
			previous &&
			(dom.viewportSize !== previous.viewportSize ||
				dom.physicalMaximum !== previous.physicalMaximum);
		if (boundsChanged && this.#deviation.value !== 0 && dom.scrollTop !== previous.scrollTop) {
			this.viewportChanged(true);
			return;
		}
		this.#lastDom = dom;
		this.#lastLogicalOffset = dom.scrollTop - dom.leadingOffset + this.#deviation.value;
		this.#publish(dom);
		if (this.#deviation.value !== 0 && this.#activity === 'idle' && dom.inPhysicalBounds) {
			this.#queueViewportChanged();
		}
	}

	setScrollActivity(activity: VirtualScrollActivity): void {
		this.#activity = activity;
		if (activity === 'idle' && this.#deviation.value !== 0) this.viewportChanged(false);
	}

	refreshLayout(): void {
		this.#queueViewportChanged();
	}

	scrollToIndex(
		index: number,
		align: 'start' | 'center' | 'end' = 'start',
	): VirtualIndexScrollResult {
		const item = this.geometry.item(index);
		return item ? this.#scrollToItem(item, align) : { kind: 'missing-index' };
	}

	scrollToKey(key: string, align: 'start' | 'center' | 'end' = 'start'): VirtualKeyScrollResult {
		const index = this.geometry.indexOf(key);
		if (index === undefined) return { kind: 'missing-key' };
		const item = this.geometry.item(index);
		return item ? this.#scrollToItem(item, align) : { kind: 'missing-key' };
	}

	#scrollToItem(item: LogicalVirtualItem, align: 'start' | 'center' | 'end'): VirtualScrollResult {
		const dom = this.#driver?.read();
		if (!dom) return { kind: 'not-ready' };
		const offset =
			align === 'center'
				? item.start - (dom.viewportSize - item.size) / 2
				: align === 'end'
					? item.end - dom.viewportSize
					: item.start;
		return this.#scheduleLogicalTarget(offset);
	}

	scrollToAnchor(key: string, viewportOffset: number): VirtualKeyScrollResult {
		const index = this.geometry.indexOf(key);
		if (index === undefined) return { kind: 'missing-key' };
		const item = this.geometry.item(index);
		return item
			? this.#scheduleLogicalTarget(item.start - viewportOffset)
			: { kind: 'missing-key' };
	}

	scrollToStart(): VirtualScrollResult {
		return this.#scheduleLogicalTarget(0);
	}

	scrollToEnd(): VirtualScrollResult {
		return this.#scheduleTarget({ kind: 'end' });
	}

	scrollBy(delta: number): VirtualScrollResult {
		const position = this.viewportPosition;
		return position
			? this.#scheduleLogicalTarget(position.logicalOffset + delta)
			: { kind: 'not-ready' };
	}

	suspend(): void {
		if (this.#suspended) return;
		this.#suspended = true;
		this.cancelOwnedScroll();
		this.#driver?.suspend();
	}

	resume(target: VirtualResumeTarget): VirtualResumeResult {
		this.#suspended = false;
		this.#driver?.resume();
		const dom = this.#driver?.read();
		if (!dom) return { kind: 'not-ready' };
		this.#replacementPending = false;
		this.#setDeviation(SETTLED_VIRTUAL_DEVIATION);
		this.#publish(dom, true);
		if (target.kind === 'start') return this.#scheduleLogicalTarget(0, 'resume');
		if (target.kind === 'end') return this.#scheduleTarget({ kind: 'end' }, 'resume');
		const index = this.geometry.indexOf(target.key);
		if (index === undefined) return { kind: 'missing-key' };
		const item = this.geometry.item(index);
		return item
			? this.#scheduleLogicalTarget(item.start - target.viewportOffset, 'resume')
			: { kind: 'missing-key' };
	}

	cancelOwnedScroll(): void {
		const restoreDeviation = this.#pendingCommit?.restoreDeviation;
		this.#pendingCommit = null;
		this.#ownedEpoch += 1;
		this.#ownsScrollPosition = false;
		if (this.#ownedFrame !== null) {
			this.options.environment.cancelAnimationFrame(this.#ownedFrame);
			this.#ownedFrame = null;
		}
		if (restoreDeviation && !this.#destroyed) {
			this.#setDeviation(restoreDeviation);
			this.#publish(this.#driver?.read() ?? this.#lastDom, true);
		}
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.cancelOwnedScroll();
		this.#setDeviation(SETTLED_VIRTUAL_DEVIATION);
		this.#driver?.destroy();
	}

	#scheduleLogicalTarget(
		offset: number,
		source: 'programmatic' | 'resume' = 'programmatic',
	): VirtualScrollResult {
		return this.#scheduleTarget({ kind: 'logical', offset }, source);
	}

	#scheduleTarget(
		target: PendingTarget,
		source: 'programmatic' | 'resume' = 'programmatic',
	): VirtualScrollResult {
		const dom = this.#driver?.read();
		if (!dom || this.#suspended) return { kind: 'not-ready' };
		this.#replacementPending = false;
		this.#setDeviation(SETTLED_VIRTUAL_DEVIATION);
		const started = this.options.environment.now();
		const record = this.#record(source, 'navigation', { kind: 'none' }, dom, started);
		this.#publish(dom, true, false, this.#logicalOffsetForTarget(target, dom));
		this.#queueCommit({
			revision: this.#snapshot.revision,
			source,
			provenance: 'navigation',
			target,
			barriers: 0,
			restoreDeviation: null,
			record,
		});
		return { kind: 'scheduled' };
	}

	#applyCorrection(input: {
		source: VirtualTransactionSource;
		provenance: VirtualCorrectionProvenance;
		anchor: VirtualMutationAnchor;
		anchorIndex: number | null;
		anchorStart: number | null;
		correction: number;
		dom: VirtualDomGeometry | null;
		started: number;
		followEnd: boolean;
		clampedRemainder?: number;
	}): void {
		const pendingCorrection = this.#pendingCommit;
		const provenance =
			pendingCorrection?.provenance === 'navigation' ? 'navigation' : input.provenance;
		const source =
			pendingCorrection?.provenance === 'navigation' ? pendingCorrection.source : input.source;
		const record = this.#record(source, provenance, input.anchor, input.dom, input.started);
		record.anchorIndex = input.anchorIndex;
		record.anchorPaintedStartBefore = input.anchorStart;
		record.correction = input.correction;
		record.clampedRemainder = input.clampedRemainder ?? 0;
		const decision = applyVirtualCorrection({
			current: this.#deviation,
			correction: input.correction,
			activity: this.#activity,
			provenance,
			inPhysicalBounds: input.dom?.inPhysicalBounds ?? false,
			now: input.started,
		});
		this.#setDeviation(decision.state);
		record.deviationAfter = decision.state.value;
		if (input.anchor.kind === 'item') {
			const index = this.geometry.indexOf(input.anchor.key);
			const item = index === undefined ? undefined : this.geometry.item(index);
			record.anchorPaintedStartAfter = item ? item.start - decision.state.value : null;
		}
		if (decision.kind === 'deferred') {
			this.#publish(input.dom, true);
			record.published = true;
			this.#emitRecord(record);
			return;
		}

		if (decision.kind === 'settled') {
			const revision = this.#snapshot.revision;
			const intendedLogicalOffset =
				this.#pendingCommit && input.dom
					? this.#logicalOffsetForTarget(this.#pendingCommit.target, input.dom)
					: undefined;
			this.#publish(input.dom, false, false, intendedLogicalOffset);
			record.published = this.#snapshot.revision !== revision;
			this.#emitRecord(record);
			return;
		}

		const target: PendingTarget =
			input.followEnd || pendingCorrection?.target.kind === 'end'
				? { kind: 'end' }
				: {
						kind: 'relative',
						offset:
							(input.dom && pendingCorrection
								? this.#physicalOffsetForTarget(pendingCorrection.target, input.dom)
								: (input.dom?.scrollTop ?? 0)) + decision.amount,
						leadingOffset: input.dom?.leadingOffset ?? 0,
					};
		this.#publish(
			input.dom,
			true,
			false,
			input.dom ? this.#logicalOffsetForTarget(target, input.dom) : undefined,
		);
		record.redeemed = true;
		this.#queueCommit({
			revision: this.#snapshot.revision,
			source,
			provenance,
			target,
			barriers: 0,
			restoreDeviation:
				pendingCorrection?.provenance === 'navigation'
					? null
					: {
							value: (pendingCorrection?.restoreDeviation?.value ?? 0) + decision.amount,
							pendingSince: input.started,
						},
			record,
		});
	}

	#captureMutationAnchor(anchor: VirtualMutationAnchor): CapturedAnchor {
		if (anchor.kind !== 'item') return anchor;
		const index = this.geometry.indexOf(anchor.key);
		if (index === undefined) return { kind: 'none' };
		const item = this.geometry.item(index);
		return item ? { kind: 'item', key: anchor.key, index, start: item.start } : { kind: 'none' };
	}

	#captureMeasurementAnchor(
		dom: VirtualDomGeometry | null,
		firstMeasurements?: ReadonlySet<string>,
	): CapturedAnchor {
		if (this.options.getMeasurementAnchor() === 'end') return { kind: 'end' };
		if (!dom || this.geometry.count === 0) return { kind: 'none' };
		const logicalOffset = this.#pendingCommit
			? this.#logicalOffsetForTarget(this.#pendingCommit.target, dom)
			: dom.scrollTop - dom.leadingOffset + this.#deviation.value;
		let item =
			this.geometry.itemAtOffset(logicalOffset) ?? this.geometry.item(this.geometry.count - 1);
		if (item && firstMeasurements?.has(item.key)) {
			const viewportEnd = logicalOffset + dom.viewportSize;
			// Pins the last measured in-view row so interleaved first measurements cannot shift it.
			for (let index = item.index + 1; index < this.geometry.count; index += 1) {
				const candidate = this.geometry.item(index);
				if (!candidate || candidate.start >= viewportEnd) break;
				if (this.geometry.measuredSize(candidate.key) === undefined) continue;
				item = candidate;
			}
		}
		return item
			? { kind: 'item', key: item.key, index: item.index, start: item.start }
			: { kind: 'none' };
	}

	#publish(
		dom: VirtualDomGeometry | null,
		force = false,
		notReady = false,
		intendedLogicalOffset?: number,
	): void {
		const observedLogicalOffset = dom
			? dom.scrollTop - dom.leadingOffset + this.#deviation.value
			: this.#lastLogicalOffset;
		const logicalOffset =
			intendedLogicalOffset === undefined || !dom
				? observedLogicalOffset
				: clamp(
						intendedLogicalOffset,
						0,
						Math.max(0, this.geometry.totalSize() - dom.viewportSize),
					);
		const visibleRange =
			!notReady && dom ? this.geometry.range(logicalOffset, dom.viewportSize) : null;
		const overscanRange = visibleRange ? this.#overscanRange(visibleRange) : null;
		const sizerSize = Math.max(0, this.geometry.totalSize() - this.#deviation.value);
		const geometryChanged = this.#publishedGeometryRevision !== this.geometry.revision;
		const deviationChanged = this.#publishedDeviation !== this.#deviation.value;
		if (
			!force &&
			!geometryChanged &&
			!deviationChanged &&
			rangesEqual(this.#snapshot.visibleRange, visibleRange) &&
			rangesEqual(this.#snapshot.overscanRange, overscanRange) &&
			this.#snapshot.sizerSize === sizerSize
		) {
			return;
		}

		this.#revision += 1;
		this.#snapshot = {
			revision: this.#revision,
			visibleRange,
			overscanRange,
			sizerSize,
			positions: this.geometry.positionView(this.#deviation.value),
		};
		this.#publishedGeometryRevision = this.geometry.revision;
		this.#publishedDeviation = this.#deviation.value;
		if (this.#pendingCommit) this.#pendingCommit.revision = this.#snapshot.revision;
		this.options.publish(this.#snapshot);
		if (dom) {
			this.#lastDom = dom;
			this.#lastLogicalOffset = logicalOffset;
		}
	}

	#logicalOffsetForTarget(target: PendingTarget, dom: VirtualDomGeometry): number {
		if (target.kind === 'end') return Math.max(0, this.geometry.totalSize() - dom.viewportSize);
		return target.kind === 'logical' ? target.offset : target.offset - target.leadingOffset;
	}

	#physicalOffsetForTarget(target: PendingTarget, dom: VirtualDomGeometry): number {
		if (target.kind === 'end') return dom.physicalMaximum;
		if (target.kind === 'logical') return dom.leadingOffset + target.offset;
		return target.offset + dom.leadingOffset - target.leadingOffset;
	}

	#overscanRange(visible: VirtualRange): VirtualRange | null {
		const overscan = Math.max(0, Math.floor(this.options.getOverscan()));
		let startIndex = Math.max(0, visible.startIndex - overscan);
		const endIndex = Math.min(this.geometry.count - 1, visible.endIndex + overscan);
		const view = this.geometry.positionView(this.#deviation.value);
		while (startIndex <= endIndex && (view.itemAt(startIndex)?.end ?? 0) <= 0) startIndex += 1;
		return startIndex <= endIndex ? { startIndex, endIndex } : null;
	}

	#setDeviation(deviation: VirtualDeviationState): void {
		const previous = this.#deviation;
		this.#deviation = deviation;
		if (deviation.pendingSince === null) {
			if (this.#deviationTimer !== null)
				this.options.environment.clearTimeout(this.#deviationTimer);
			this.#deviationTimer = null;
			return;
		}
		if (previous.pendingSince === deviation.pendingSince) return;
		if (this.#deviationTimer !== null) this.options.environment.clearTimeout(this.#deviationTimer);
		const pendingSince = deviation.pendingSince;
		const delay = Math.max(0, pendingSince + 1_000 - this.options.environment.now());
		this.#deviationTimer = this.options.environment.setTimeout(() => {
			this.#deviationTimer = null;
			if (
				this.#deviation.pendingSince === pendingSince &&
				this.options.environment.now() - pendingSince >= 1_000
			) {
				this.viewportChanged(false);
			}
		}, delay);
	}

	#queueViewportChanged(): void {
		if (this.#viewportQueued) return;
		this.#viewportQueued = true;
		this.options.environment.queueMicrotask(() => {
			this.#viewportQueued = false;
			this.viewportChanged(false);
		});
	}

	#queueCommit(commit: PendingCommit): void {
		this.#pendingCommit = commit;
		if (this.#commitQueued) return;
		this.#commitQueued = true;
		this.options.environment.queueMicrotask(() => this.#commit());
	}

	#commit(): void {
		this.#commitQueued = false;
		const commit = this.#pendingCommit;
		if (!commit) return;
		const dom = this.#driver?.read();
		if (!dom || this.#destroyed || this.#suspended || commit.revision !== this.#snapshot.revision) {
			this.cancelOwnedScroll();
			return;
		}

		const leadingAtPlan =
			commit.target.kind === 'relative'
				? commit.target.leadingOffset
				: this.#lastDom?.leadingOffset;
		if (leadingAtPlan !== undefined && Math.abs(dom.leadingOffset - leadingAtPlan) > 0.5) {
			if (commit.barriers >= 2) {
				commit.record.leadingOffsetAfter = dom.leadingOffset;
				commit.record.published = true;
				this.#emitRecord(commit.record);
				this.options.environment.requestAnimationFrame(() => {
					if (this.#pendingCommit === commit && !this.#commitQueued) this.viewportChanged(false);
				});
				return;
			}
			if (commit.target.kind === 'relative') {
				commit.target.offset += dom.leadingOffset - commit.target.leadingOffset;
				commit.target.leadingOffset = dom.leadingOffset;
			}
			commit.barriers += 1;
			this.#publish(dom, true, false, this.#logicalOffsetForTarget(commit.target, dom));
			commit.revision = this.#snapshot.revision;
			this.#queueCommit(commit);
			return;
		}

		this.#pendingCommit = null;
		const intended = this.#resolveTarget(commit.target, dom);
		commit.record.intendedScrollTop = intended;
		commit.record.leadingOffsetAfter = dom.leadingOffset;
		commit.record.published = true;
		this.#writeScroll(intended, commit.record);
	}

	#resolveTarget(target: PendingTarget, dom: VirtualDomGeometry): number {
		if (target.kind === 'end') return dom.physicalMaximum;
		if (target.kind === 'logical') {
			return clamp(dom.leadingOffset + target.offset, 0, dom.physicalMaximum);
		}
		return clamp(target.offset, 0, dom.physicalMaximum);
	}

	#writeScroll(intended: number, record: MutableTransactionRecord): void {
		const driver = this.#driver;
		if (!driver) return;
		this.#ownedEpoch += 1;
		const epoch = this.#ownedEpoch;
		this.#ownsScrollPosition = true;
		if (this.#ownedFrame !== null) this.options.environment.cancelAnimationFrame(this.#ownedFrame);
		record.scrollWrites = 1;
		record.attainedScrollTop = driver.writeScrollTop(intended);
		record.clampedRemainder += intended - record.attainedScrollTop;
		record.durationMs =
			this.options.environment.now() - (record.durationMs < 0 ? -record.durationMs : 0);
		this.#emitRecord(record);
		this.#ownedFrame = this.options.environment.requestAnimationFrame(() => {
			if (this.#ownedEpoch !== epoch) return;
			const dom = driver.read();
			if (dom) {
				this.#lastDom = dom;
				this.#lastLogicalOffset = dom.scrollTop - dom.leadingOffset + this.#deviation.value;
				this.#publish(dom);
			}
			this.#ownsScrollPosition = false;
			this.#ownedFrame = null;
		});
	}

	#record(
		source: VirtualTransactionSource,
		provenance: VirtualCorrectionProvenance | null,
		anchor: VirtualMutationAnchor,
		dom: VirtualDomGeometry | null,
		started: number,
	): MutableTransactionRecord {
		const operations = this.geometry.operationCounts;
		return {
			revision: this.#revision + 1,
			source,
			rejectionReason: null,
			provenance,
			activity: this.#activity,
			anchorKind: anchor.kind,
			anchorIndex: null,
			anchorPaintedStartBefore: null,
			anchorPaintedStartAfter: null,
			changedCount: operations.changedCount,
			firstChangedIndex: operations.firstChangedIndex,
			correction: 0,
			scrollTopBefore: dom?.scrollTop ?? 0,
			intendedScrollTop: dom?.scrollTop ?? 0,
			attainedScrollTop: dom?.scrollTop ?? 0,
			leadingOffsetBefore: this.#lastDom?.leadingOffset ?? dom?.leadingOffset ?? 0,
			leadingOffsetAfter: dom?.leadingOffset ?? 0,
			deviationBefore: this.#deviation.value,
			deviationAfter: this.#deviation.value,
			redeemed: false,
			clampedRemainder: 0,
			published: false,
			scrollWrites: 0,
			durationMs: -started,
			ignoredEntries: this.#driver?.drainIgnoredEntries() ?? 0,
		};
	}

	#emitRecord(record: MutableTransactionRecord): void {
		if (record.durationMs < 0)
			record.durationMs = this.options.environment.now() + record.durationMs;
		record.revision = this.#snapshot.revision;
		this.options.onTransaction?.(Object.freeze({ ...record }));
	}
}

function validateMutation(
	mutation: VirtualItemsMutation,
	geometry: VirtualListGeometry,
): Extract<VirtualMutationResult, { kind: 'rejected' }> | null {
	if (mutation.keys.length !== mutation.estimates.length)
		return { kind: 'rejected', reason: 'length-mismatch' };
	let prefix = 0;
	while (prefix < geometry.count && geometry.keyAt(prefix) === mutation.keys[prefix]) prefix += 1;
	const appended = prefix === geometry.count && mutation.keys.length >= geometry.count;
	const newKeys = appended ? mutation.keys.slice(prefix) : mutation.keys;
	const uniqueNewKeys = new Set(newKeys);
	const duplicatesExisting = appended && newKeys.some((key) => geometry.indexOf(key) !== undefined);
	if (duplicatesExisting || uniqueNewKeys.size !== newKeys.length)
		return { kind: 'rejected', reason: 'duplicate-key' };
	if (mutation.estimates.some((estimate) => !Number.isFinite(estimate) || estimate < 0))
		return { kind: 'rejected', reason: 'invalid-estimate' };
	return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function rangesEqual(left: VirtualRange | null, right: VirtualRange | null): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.startIndex === right.startIndex &&
			left.endIndex === right.endIndex)
	);
}
