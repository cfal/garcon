import {
	fitModelTrigger,
	type ModelTriggerDisplay,
	type ModelTriggerWidths,
} from '$lib/agents/model-trigger-fit';

export type PromptActionId = 'image' | 'snippet' | 'expand' | 'refine';
export type ComposerSettingId = 'executor' | 'model' | 'effort' | 'permission' | `agent:${string}`;
export type ComposerControlId = PromptActionId | ComposerSettingId;

export interface ComposerToolbarControls {
	prompt: readonly PromptActionId[];
	settings: readonly ComposerSettingId[];
	send: boolean;
	refining: boolean;
	bypass: boolean;
}

// Widths are in rem, matching the toolbar's size-9 controls and gap-1 spacing.
const icon = 2.25;
const gap = 0.25;
const labelledExecutor = 9;

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
) {
	const inline = new Set<ComposerControlId>();
	const hidden = (group: readonly ComposerControlId[]) => group.some((id) => !inline.has(id));
	function minimumWidth() {
		const count =
			inline.size +
			Number(controls.send) +
			Number(hidden(controls.prompt)) +
			Number(hidden(controls.settings));
		const sendSeparation = controls.send && count > 1 ? gap : 0;
		return (
			count * icon +
			Math.max(0, count - 1) * gap +
			sendSeparation +
			(inline.has('model') ? modelWidthsRem.model - icon : 0)
		);
	}

	const ids = [...controls.prompt, ...controls.settings];
	if (widthRem > 0) {
		// A model too wide to promote must not displace smaller controls that still fit.
		for (const id of ids.sort((a, b) => retention(b, controls) - retention(a, controls))) {
			const previous = minimumWidth();
			inline.add(id);
			const budget = id === 'model' ? widthRem : Math.max(widthRem, previous);
			if (minimumWidth() > budget) inline.delete(id);
		}
	} else {
		for (const id of ids) if (id !== 'image' && id !== 'snippet') inline.add(id);
	}
	let spare = widthRem > 0 ? Math.max(0, widthRem - minimumWidth()) : Infinity;
	const modelDisplay: ModelTriggerDisplay = inline.has('model')
		? fitModelTrigger(modelWidthsRem, modelWidthsRem.model + spare)
		: 'overflow';
	if (modelDisplay === 'combined') spare -= modelWidthsRem.combined - modelWidthsRem.model;
	const fullExecutor = inline.has('executor') && spare >= labelledExecutor - icon;
	return {
		inline,
		promptMenu: hidden(controls.prompt),
		settingsMenu: hidden(controls.settings),
		fullExecutor,
		modelDisplay,
	};
}
