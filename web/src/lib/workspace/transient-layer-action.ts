import type {
	TransientLayerKind,
	TransientLayerModality,
	TransientLayerRegistry,
} from './transient-layers.svelte.js';
import type { Attachment } from 'svelte/attachments';

export interface TransientLayerActionOptions {
	registry: TransientLayerRegistry;
	id: string;
	kind: TransientLayerKind;
	modality: TransientLayerModality;
	onEscape: () => boolean;
	restoreFocus: () => void;
}

function registerTransientLayer(
	node: HTMLElement,
	options: TransientLayerActionOptions,
): () => void {
	return options.registry.register({
		id: options.id,
		kind: options.kind,
		modality: options.modality,
		element: () => node,
		onEscape: options.onEscape,
		restoreFocus: options.restoreFocus,
	});
}

export function transientLayer(
	node: HTMLElement,
	options: TransientLayerActionOptions,
): { destroy(): void } {
	return { destroy: registerTransientLayer(node, options) };
}

export function transientLayerAttachment(
	options: TransientLayerActionOptions,
): Attachment<HTMLElement> {
	return (node) => registerTransientLayer(node, options);
}
