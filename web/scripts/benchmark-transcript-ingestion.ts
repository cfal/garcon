import { AssistantMessage } from '../../common/chat-types.js';
import { applyChatViewMessages, type ChatViewMessage } from '../../common/chat-view.js';

const MESSAGE_COUNT = Number(process.env.GARCON_PROFILE_MESSAGE_COUNT ?? 20_000);
const RETENTION_LIMIT = Number(process.env.GARCON_PROFILE_RETENTION_LIMIT ?? 200);
const RUNS = Number(process.env.GARCON_PROFILE_RUNS ?? 7);
const TAIL_MESSAGE_COUNT = Math.min(1_000, MESSAGE_COUNT);
const TIMESTAMP = '2026-07-28T00:00:00.000Z';

interface IngestionSample {
	durationMs: number;
	tailDurationMs: number;
	retainedMessages: number;
}

function percentile(values: number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function collectGarbage(): void {
	Bun.gc(true);
}

function ingest(retentionLimit: number | null): IngestionSample {
	collectGarbage();
	let entries: ChatViewMessage[] = [];
	let lastSeq = 0;
	const startedAt = performance.now();
	let tailStartedAt = startedAt;
	for (let seq = 1; seq <= MESSAGE_COUNT; seq += 1) {
		if (seq === MESSAGE_COUNT - TAIL_MESSAGE_COUNT + 1) tailStartedAt = performance.now();
		const incoming = [
			{
				seq,
				message: new AssistantMessage(TIMESTAMP, `message-${seq}-${'x'.repeat(48)}`),
			},
		];
		const applied = applyChatViewMessages(entries, incoming, lastSeq);
		if (applied.status !== 'applied') throw new Error(`Unexpected gap at ${seq}`);
		entries =
			retentionLimit && applied.messages.length > retentionLimit
				? applied.messages.slice(-retentionLimit)
				: applied.messages;
		lastSeq = applied.lastSeq;
	}
	const durationMs = performance.now() - startedAt;
	return {
		durationMs,
		tailDurationMs: performance.now() - tailStartedAt,
		retainedMessages: entries.length,
	};
}

function profile(retentionLimit: number | null) {
	ingest(retentionLimit);
	const samples = Array.from({ length: RUNS }, () => ingest(retentionLimit));
	const durations = samples.map((sample) => sample.durationMs);
	const tailDurations = samples.map((sample) => sample.tailDurationMs);
	return {
		retentionLimit,
		retainedMessages: samples.at(-1)?.retainedMessages ?? 0,
		durationMs: {
			samples: durations,
			p50: percentile(durations, 0.5),
			p95: percentile(durations, 0.95),
		},
		tailDurationMs: {
			messageCount: TAIL_MESSAGE_COUNT,
			samples: tailDurations,
			p50: percentile(tailDurations, 0.5),
			p95: percentile(tailDurations, 0.95),
		},
	};
}

console.log(
	JSON.stringify(
		{
			messageCount: MESSAGE_COUNT,
			runs: RUNS,
			unbounded: profile(null),
			bounded: profile(RETENTION_LIMIT),
		},
		null,
		2,
	),
);
