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
const readableModel = 7;
const fullModel = 15;
const labelledExecutor = 9;

function retention(id: ComposerControlId, controls: ComposerToolbarControls): number {
	switch (id) {
		case 'snippet': return 0;
		case 'image': return 1;
		case 'permission': return controls.bypass ? 9 : 3;
		case 'refine': return controls.refining ? 10 : 4;
		case 'expand': return 5;
		case 'effort': return 6;
		case 'executor': return 7;
		case 'model': return 8;
		default: return 2;
	}
}

export function fitComposerToolbar(controls: ComposerToolbarControls, widthRem: number) {
	const ids = [...controls.prompt, ...controls.settings];
	const inline = new Set<ComposerControlId>(ids);
	const hidden = (group: readonly ComposerControlId[]) => group.some((id) => !inline.has(id));
	function minimumWidth() {
		const count = inline.size + Number(controls.send) + Number(hidden(controls.prompt)) + Number(hidden(controls.settings));
		return count * icon + Math.max(0, count - 1) * gap + (inline.has('model') ? readableModel - icon : 0);
	}

	if (widthRem > 0) {
		for (const id of ids.sort((a, b) => retention(a, controls) - retention(b, controls))) {
			if (minimumWidth() <= widthRem) break;
			inline.delete(id);
		}
		// A lone icon costs no more than the menu button it would replace.
		for (const group of [controls.prompt, controls.settings]) {
			const folded = group.filter((id) => !inline.has(id));
			if (folded.length === 1 && folded[0] !== 'model') inline.add(folded[0]);
		}
	} else {
		// Before measurement, keep attachment actions accessible through their usual menu.
		inline.delete('image');
		inline.delete('snippet');
	}
	const spare = widthRem > 0 ? Math.max(0, widthRem - minimumWidth()) : Infinity;
	const fullExecutor = inline.has('executor') && spare >= labelledExecutor - icon;
	return {
		inline,
		promptMenu: hidden(controls.prompt),
		settingsMenu: hidden(controls.settings),
		fullExecutor,
		modelWidthRem: Math.min(fullModel, readableModel + spare - (fullExecutor ? labelledExecutor - icon : 0)),
	};
}
