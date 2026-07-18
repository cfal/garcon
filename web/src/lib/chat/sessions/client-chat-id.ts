import { chatIdFromEpochMicroseconds, type ChatId } from '$shared/chat-id';

let lastIssued = 0n;
const MIN_CANONICAL_EPOCH_MS = 1_000_000_000_000;
const MAX_SAFE_EPOCH_MS = Number.MAX_SAFE_INTEGER / 1_000;

function observedEpochMicroseconds(): bigint {
	if (typeof performance === 'undefined') return BigInt(Date.now()) * 1_000n;
	const observedMs = performance.timeOrigin + performance.now();
	// Some runtimes, including Lightpanda, report a non-Unix performance time origin.
	if (
		!Number.isFinite(observedMs) ||
		observedMs < MIN_CANONICAL_EPOCH_MS ||
		observedMs > MAX_SAFE_EPOCH_MS
	) {
		return BigInt(Date.now()) * 1_000n;
	}
	const epochMs = Math.floor(observedMs);
	const microsWithinMs = Math.floor((observedMs - epochMs) * 1_000);
	return BigInt(epochMs) * 1_000n + BigInt(microsWithinMs);
}

export function createClientChatId(): ChatId {
	const observed = observedEpochMicroseconds();
	const next = observed > lastIssued ? observed : lastIssued + 1n;
	const chatId = chatIdFromEpochMicroseconds(next);
	lastIssued = BigInt(chatId);
	return chatId;
}
