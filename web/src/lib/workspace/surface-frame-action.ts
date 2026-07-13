import type { PresentationHostId } from './surface-types.js';
import type { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import type { SurfaceFrameBridge } from './surface-frame-context.js';

export interface SurfaceFrameActionOptions {
	registry: SurfaceFrameRegistry;
	surfaceId: string;
	host: PresentationHostId | null;
	version: number;
	renderer?: SurfaceFrameBridge;
}

function primaryControl(node: HTMLElement): HTMLElement {
	return (
		node.querySelector<HTMLElement>(
			'[data-surface-primary], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
		) ?? node
	);
}

export function surfaceFrame(
	node: HTMLElement,
	initialOptions: SurfaceFrameActionOptions,
): { update(options: SurfaceFrameActionOptions): void; destroy(): void } {
	let unregister: (() => void) | null = null;
	let renderer = initialOptions.renderer;

	function register(options: SurfaceFrameActionOptions): void {
		renderer = options.renderer;
		unregister?.();
		unregister = null;
		if (!options.host) {
			options.renderer?.deactivate();
			return;
		}
		unregister = options.registry.register(options.surfaceId, options.host, {
			element: node,
			attachRetainedRenderer: () => options.renderer?.activate(),
			focusPrimary: () => {
				if (!options.renderer?.focusPrimary()) primaryControl(node).focus();
			},
		});
	}

	register(initialOptions);
	return {
		update: register,
		destroy() {
			unregister?.();
			renderer?.deactivate();
		},
	};
}
