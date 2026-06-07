import type { ModelOption } from '$lib/stores/model-catalog.svelte.js';

function normalizedFastLabel(label: string): string {
	return label.replace(/\s+Fast Mode$/i, '').trim();
}

export function fastModeModelValue(models: ModelOption[], modelValue: string): string {
	if (!modelValue || modelValue.endsWith('-fast')) return modelValue;

	const exactFastValue = `${modelValue}-fast`;
	if (models.some((model) => model.value === exactFastValue)) return exactFastValue;

	const selected = models.find((model) => model.value === modelValue);
	if (!selected) return modelValue;

	const selectedLabel = normalizedFastLabel(selected.label);
	const labelMatch = models.find((model) =>
		model.value !== modelValue
		&& /\sFast Mode$/i.test(model.label)
		&& normalizedFastLabel(model.label) === selectedLabel
	);

	return labelMatch?.value ?? modelValue;
}
