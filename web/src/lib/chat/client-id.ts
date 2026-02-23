// Generates a high-precision timestamp-based chat ID on the client.

export function createClientChatId(): string {
	if (typeof performance === 'undefined') return String(Date.now());
	const elapsedMs = performance.now();
	const epochMs = Math.trunc(performance.timeOrigin + elapsedMs);
	const micros = Math.floor((elapsedMs % 1) * 1000);
	return `${epochMs}${String(micros).padStart(3, '0')}`;
}
