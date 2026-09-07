import type { Attachment } from 'svelte/attachments';

export function processingPulsePhaseMs(durationMs: number, nowMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
	return nowMs % durationMs;
}

function alignProcessingPulse(element: HTMLElement, nowMs = performance.now()): void {
	for (const animation of element.getAnimations()) {
		if (animation.currentTime === null) continue;
		const durationMs = Number(animation.effect?.getComputedTiming().duration);
		animation.currentTime = processingPulsePhaseMs(durationMs, nowMs);
	}
}

// Aligns independently mounted processing animations to one document-wide timeline.
export const attachProcessingPulse: Attachment<HTMLElement> = (element) => {
	const handleAnimationStart = (event: AnimationEvent) => {
		if (event.target === element) alignProcessingPulse(element);
	};

	element.addEventListener('animationstart', handleAnimationStart);
	alignProcessingPulse(element);

	return () => element.removeEventListener('animationstart', handleAnimationStart);
};
