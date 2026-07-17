import type {
	ContainerPresentationBreakpoints,
} from '$lib/components/shared/container-presentation.js';

export const gitContainerBreakpoints = {
	compactMinWidth: 560,
	wideMinWidth: 840,
} as const satisfies ContainerPresentationBreakpoints;
