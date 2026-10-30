import { describe, expect, it, vi } from 'vitest';
import {
	MissedTranscriptCatchUp,
	type MissedTranscriptCatchUpPort,
	type TranscriptAdvance,
} from '../missed-transcript-catch-up.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function harness(options: { displayed?: boolean } = {}) {
	let cursor = 1;
	let inFlight: Promise<void> | null = null;
	const loads: Array<{ readThrough: number; finish: (loaded: boolean) => void }> = [];
	let serverThrough = 1;
	const port = {
		covers: vi.fn((_chatId: string, advance: TranscriptAdvance) => cursor >= advance.lastOrdinal),
		isDisplayed: vi.fn(() => options.displayed ?? true),
		settleLoads: vi.fn(async () => {
			while (inFlight) await inFlight;
		}),
		load: vi.fn((_chatId: string) => {
			const readThrough = serverThrough;
			const done = deferred<boolean>();
			loads.push({ readThrough, finish: done.resolve });
			const load = done.promise.then((loaded) => {
				if (loaded) cursor = readThrough;
				if (inFlight === tracked) inFlight = null;
				return loaded;
			});
			const tracked = load.then(() => undefined);
			inFlight = tracked;
			return load;
		}),
		markLoadFailed: vi.fn(),
	} satisfies MissedTranscriptCatchUpPort;
	return {
		port,
		loads,
		catchUp: new MissedTranscriptCatchUp(port),
		commit(through: number) {
			serverThrough = through;
		},
		cursor: () => cursor,
	};
}

const view = 'view-1';

describe('MissedTranscriptCatchUp', () => {
	it('ignores a summary the cache already covers', () => {
		const { catchUp, port } = harness();

		catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 1 });

		expect(port.load).not.toHaveBeenCalled();
	});

	it('defers an undisplayed chat to its next showing without loading it', () => {
		const { catchUp, port } = harness({ displayed: false });

		catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 4 });

		expect(port.load).not.toHaveBeenCalled();
	});

	it('loads again after a load that started before the summarized rows', async () => {
		const state = harness();
		void state.port.load('chat-1');
		state.commit(3);

		state.catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 3 });
		state.catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 2 });
		await Promise.resolve();
		expect(state.loads).toHaveLength(1);
		state.loads[0].finish(true);

		await vi.waitFor(() => expect(state.loads).toHaveLength(2));
		expect(state.loads[1].readThrough).toBe(3);
		state.loads[1].finish(true);
		await vi.waitFor(() => expect(state.cursor()).toBe(3));
		await Promise.resolve();
		expect(state.loads).toHaveLength(2);
	});

	it('repeats once for an advance that arrives while it loads', async () => {
		const state = harness();
		state.commit(2);
		state.catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 2 });
		await vi.waitFor(() => expect(state.loads).toHaveLength(1));

		state.commit(4);
		state.catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 4 });
		state.loads[0].finish(true);
		await vi.waitFor(() => expect(state.loads).toHaveLength(2));
		state.loads[1].finish(true);

		await vi.waitFor(() => expect(state.cursor()).toBe(4));
	});

	it('ignores a retired catch-up failure after view replacement', async () => {
		const target = harness();
		target.commit(2);
		target.catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 2 });
		await vi.waitFor(() => expect(target.loads).toHaveLength(1));
		target.catchUp.forget('chat-1');
		target.loads[0].finish(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(target.port.markLoadFailed).not.toHaveBeenCalled();
	});

	it('leaves a chat stale when its catch-up load fails', async () => {
		const state = harness();
		state.commit(2);
		state.catchUp.apply('chat-1', { transcriptViewId: view, lastOrdinal: 2 });
		await vi.waitFor(() => expect(state.loads).toHaveLength(1));

		state.loads[0].finish(false);

		await vi.waitFor(() => expect(state.port.markLoadFailed).toHaveBeenCalledWith('chat-1'));
		expect(state.cursor()).toBe(1);
	});
});
