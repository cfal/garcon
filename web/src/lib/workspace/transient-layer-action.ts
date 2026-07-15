import type {
	TransientLayerKind,
	TransientLayerModality,
	TransientLayerRegistry,
} from './transient-layers.svelte.js';

export interface TransientLayerActionOptions {
	registry: TransientLayerRegistry;
	id: string;
	kind: TransientLayerKind;
	modality: TransientLayerModality;
	onEscape: () => boolean;
	restoreFocus: () => void;
}

export function transientLayer(
	node: HTMLElement,
	options: TransientLayerActionOptions,
): { destroy(): void } {
	const unregister = options.registry.register({
		id: options.id,
		kind: options.kind,
		modality: options.modality,
		element: () => node,
		onEscape: options.onEscape,
		restoreFocus: options.restoreFocus,
	});
	return { destroy: unregister };
}
