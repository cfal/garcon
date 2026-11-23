export interface ModelTriggerWidths {
	model: number;
	combined: number;
}

export type ModelTriggerDisplay = 'combined' | 'model' | 'overflow';

export function fitModelTrigger(
	widths: ModelTriggerWidths,
	available: number,
): ModelTriggerDisplay {
	if (widths.combined <= available) return 'combined';
	return widths.model <= available ? 'model' : 'overflow';
}
