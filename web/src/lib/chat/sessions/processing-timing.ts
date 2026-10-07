import type { ChatProcessingTiming } from '$shared/chat-types';

export interface ProcessingTimingObservation {
	readonly timing: ChatProcessingTiming;
	readonly receivedAt: number;
}

export function processingDurations(
	observation: ProcessingTimingObservation,
	now: number,
): { elapsed: string; lastOutput: string | null } {
	const serverNow = observation.timing.observedAt + Math.max(0, now - observation.receivedAt);
	return {
		elapsed: formatDuration(serverNow - observation.timing.startedAt),
		lastOutput:
			observation.timing.lastOutputAt === null
				? null
				: formatDuration(serverNow - observation.timing.lastOutputAt),
	};
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
