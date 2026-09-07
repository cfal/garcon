import type { Attachment } from 'svelte/attachments';

export function thinkingPulsePhaseMs(durationMs: number, nowMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
	return nowMs % durationMs;
}

function alignThinkingPulse(element: HTMLElement, nowMs = performance.now()): void {
	for (const animation of element.getAnimations()) {
		if (animation.currentTime === null) continue;
		const durationMs = Number(animation.effect?.getComputedTiming().duration);
		animation.currentTime = thinkingPulsePhaseMs(durationMs, nowMs);
	}
}

// Aligns the detached composer and status dock to one document-wide animation phase.
export const attachThinkingPulse: Attachment<HTMLElement> = (element) => {
	const handleAnimationStart = (event: AnimationEvent) => {
		if (event.target === element) alignThinkingPulse(element);
	};

	element.addEventListener('animationstart', handleAnimationStart);
	alignThinkingPulse(element);

	return () => element.removeEventListener('animationstart', handleAnimationStart);
};
