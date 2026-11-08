import type { AuxiliaryResponse, DisplayAuxiliaryRequest, SubagentSummaryPage } from '$shared/transcript-display-auxiliary';
import { ApiError } from '$lib/api/client.js';
import type { DisplaySummaryPaging } from './display-summary-paging.js';

interface SummaryTarget { readonly chatId: string; readonly transcriptViewId: string; readonly serverInstanceId: string }

export class SubagentSummaryController implements DisplaySummaryPaging {
	page = $state.raw<SubagentSummaryPage | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	sourceHead = $state(0);
	#target: SummaryTarget | null = null;
	#abort: AbortController | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#cursor = $state<number | null>(null);
	#previous = $state<(number | null)[]>([]);
	#epoch = 0;
	#enabled = false;
	#dirty = false;
	#generationStale = $state(false);
	#navigation: { cursor: number | null; previous: (number | null)[] } | null = null;

	constructor(private readonly read: (request: DisplayAuxiliaryRequest, signal: AbortSignal) => Promise<AuxiliaryResponse<SubagentSummaryPage>>) {}

	get hasNext(): boolean { return this.page !== null && this.page.nextAfterOrder !== null; }
	get hasPrevious(): boolean { return this.#previous.length > 0; }
	get stale(): boolean { return this.#generationStale || this.#cursor !== null && this.page !== null && this.page.watermark < this.sourceHead; }
	get updating(): boolean { return this.loading || !this.#generationStale && (!this.page || this.#cursor === null && this.page.watermark < this.sourceHead); }

	configure(target: SummaryTarget | null, sourceHead: number, enabled = true): void {
		if (target?.chatId !== this.#target?.chatId || target?.transcriptViewId !== this.#target?.transcriptViewId
			|| target?.serverInstanceId !== this.#target?.serverInstanceId) {
			this.reset();
			this.#target = target;
		}
		this.sourceHead = Math.max(this.sourceHead, sourceHead);
		this.#enabled = enabled && target !== null;
		if (!this.#enabled) { this.#cancel(); return; }
		if (!this.#generationStale && (!this.page || this.#cursor === null && this.page.watermark < this.sourceHead)) this.#schedule(250);
	}
	ready(): void { if (this.#enabled && !this.error && this.updating) this.#schedule(0); }
	retry(): Promise<void> {
		if (this.loading) return Promise.resolve();
		if (!this.error && this.stale) this.#navigation = { cursor: null, previous: [] };
		this.error = null;
		return this.#load();
	}
	async next(): Promise<void> {
		if (!this.page || this.loading) return;
		const cursor = this.page.nextAfterOrder;
		if (cursor === null) return;
		this.#navigation = { cursor, previous: [...this.#previous.slice(-99), this.#cursor ?? 0] };
		await this.#load();
	}
	async previous(): Promise<void> {
		if (!this.#previous.length || this.loading) return;
		this.#navigation = { cursor: this.#previous.at(-1)!, previous: this.#previous.slice(0, -1) };
		await this.#load();
	}
	async #load(): Promise<void> {
		const target = this.#target;
		if (!target || !this.#enabled || this.#abort || this.#generationStale && this.#navigation?.cursor !== null) return;
		this.#dirty = false;
		const epoch = this.#epoch;
		const abort = new AbortController();
		const navigation = this.#navigation ?? { cursor: this.#cursor, previous: this.#previous };
		this.#abort = abort;
		this.loading = true;
		this.error = null;
		try {
			const response = await this.read({ ...target, mode: 'navigation', limit: 50,
				...(navigation.cursor === null ? {} : { afterOrder: navigation.cursor, atWatermark: this.page?.watermark }) }, abort.signal);
			if (abort.signal.aborted || epoch !== this.#epoch) return;
			if (response.chatId !== target.chatId || response.transcriptViewId !== target.transcriptViewId || response.serverInstanceId !== target.serverInstanceId) throw new Error('Foreign transcript summary');
			if (response.kind === 'failed') throw new Error(response.errorCode ?? 'Transcript summary unavailable');
			if (response.kind === 'available') {
				if (navigation.cursor !== null && response.watermark !== this.page?.watermark) throw new Error('Mismatched summary generation');
				this.#cursor = navigation.cursor;
				this.#previous = navigation.previous;
				this.#navigation = null;
				this.#generationStale = false;
				this.page = response;
			}
			if (response.kind === 'preparing' || navigation.cursor === null && response.watermark < this.sourceHead) this.#schedule(1500);
		} catch (error) {
			if (!abort.signal.aborted && epoch === this.#epoch) {
				if (error instanceof ApiError && error.errorCode === 'DISPLAY_STALE_WATERMARK') {
					if (navigation.cursor === null) this.#schedule(1500);
					else {
						this.#navigation = null;
						this.#generationStale = true;
						this.#dirty = false;
						if (this.#timer !== null) clearTimeout(this.#timer);
						this.#timer = null;
					}
				} else this.error = error instanceof Error ? error.message : 'Transcript summary unavailable';
			}
		} finally {
			if (epoch === this.#epoch) {
				this.#abort = null;
				this.loading = false;
				if (this.#dirty) this.#schedule(1500);
			}
		}
	}
	#schedule(delay: number): void {
		this.#dirty = true;
		if (this.#timer !== null) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.#load();
		}, delay);
	}
	#cancel(): void {
		this.#epoch++;
		this.#abort?.abort();
		this.#abort = null;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#dirty = false;
		this.loading = false;
	}
	reset(): void {
		this.#cancel();
		this.#target = null;
		this.page = null;
		this.#cursor = null;
		this.#previous = [];
		this.#navigation = null;
		this.sourceHead = 0;
		this.error = null;
		this.#generationStale = false;
	}
}
