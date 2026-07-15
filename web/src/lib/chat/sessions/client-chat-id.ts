import { chatIdFromEpochMicroseconds, type ChatId } from '$shared/chat-id';

let lastIssued = 0n;

function observedEpochMicroseconds(): bigint {
	if (typeof performance === 'undefined') return BigInt(Date.now()) * 1_000n;
	const observedMs = performance.timeOrigin + performance.now();
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
