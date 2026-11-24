import {
	fitModelTrigger,
	type ModelTriggerDisplay,
	type ModelTriggerWidths,
} from '$lib/agents/model-trigger-fit';

export type PromptActionId = 'image' | 'snippet' | 'expand' | 'refine';
export type ComposerSettingId = 'executor' | 'model' | 'effort' | 'permission' | `agent:${string}`;
export type ComposerControlId = PromptActionId | ComposerSettingId;
export type ComposerControlPlacement = 'inline' | 'hidden' | 'menu';
export type ComposerToolbarLayout = ReturnType<typeof fitComposerToolbar>;

export interface ComposerToolbarControls {
	prompt: readonly PromptActionId[];
	settings: readonly ComposerSettingId[];
	send: boolean;
	refining: boolean;
	bypass: boolean;
	explainUnavailableImage?: boolean;
}

// Widths are in rem, matching the toolbar's size-9 controls and gap-1 spacing.
const icon = 2.25;
const gap = 0.25;

function retention(id: ComposerControlId, controls: ComposerToolbarControls): number {
	switch (id) {
		case 'snippet':
			return 0;
		case 'image':
			return 1;
		case 'permission':
			return controls.bypass ? 9 : 3;
		case 'refine':
			return controls.refining ? 10 : 4;
		case 'expand':
			return 5;
		case 'effort':
			return 6;
		case 'executor':
			return 7;
		case 'model':
			return 8;
		default:
			return 2;
	}
}

export function fitComposerToolbar(
	controls: ComposerToolbarControls,
	widthRem: number,
	modelWidthsRem: ModelTriggerWidths = { model: icon, combined: icon },
	executorWidthRem?: number,
) {
	const inline = new Set<ComposerControlId>();
	const isFolded = (id: ComposerControlId) => !inline.has(id);
	function rowWidth() {
		const count =
			inline.size +
			Number(controls.send) +
			Number(controls.prompt.some(isFolded)) +
			Number(controls.settings.some(isFolded));
		const sendSeparation = controls.send && count > 1 ? gap : 0;
		return (
			count * icon +
			Math.max(0, count - 1) * gap +
			sendSeparation +
			(inline.has('model') ? modelWidthsRem.model - icon : 0)
		);
	}

	const ids = [...controls.prompt, ...controls.settings];
	let spare = Infinity;
	if (widthRem > 0) {
		let occupied = rowWidth();
		ids.sort((a, b) => retention(b, controls) - retention(a, controls));
		for (const id of ids) {
			if (id === 'image' && controls.explainUnavailableImage) continue;
			inline.add(id);
			const proposed = rowWidth();
			// Even below the minimum width, an icon can replace its own overflow button for free.
			if (proposed <= widthRem || (id !== 'model' && proposed <= occupied)) {
				occupied = proposed;
			} else {
				inline.delete(id);
			}
		}
		spare = Math.max(0, widthRem - occupied);
	} else {
		for (const id of ids) {
			if (id !== 'image' && id !== 'snippet') inline.add(id);
		}
	}
	// Labels expand only with space that cannot keep another button inline.
	const modelDisplay: ModelTriggerDisplay = inline.has('model')
		? fitModelTrigger(modelWidthsRem, modelWidthsRem.model + spare)
		: 'overflow';
	const prefixWidth =
		modelDisplay === 'combined' ? modelWidthsRem.combined - modelWidthsRem.model : 0;
	const executorFits =
		executorWidthRem !== undefined && executorWidthRem - icon <= spare - prefixWidth;
	return {
		inline,
		foldedPrompt: controls.prompt.filter(isFolded),
		foldedSettings: controls.settings.filter(isFolded),
		fullExecutor: inline.has('executor') && (widthRem <= 0 || executorFits),
		modelDisplay,
	};
}
