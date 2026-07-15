import { afterEach, describe, expect, it } from 'vitest';
import { surfaceFrame } from '../surface-frame-action.js';
import { SurfaceFrameRegistry } from '../surface-frame-registry.svelte.js';

describe('surfaceFrame', () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it('focuses an explicit primary target before toolbar controls', () => {
		const registry = new SurfaceFrameRegistry();
		const surface = document.createElement('div');
		const toolbarButton = document.createElement('button');
		const primaryTarget = document.createElement('textarea');
		primaryTarget.dataset.surfacePrimary = '';
		surface.append(toolbarButton, primaryTarget);
		document.body.append(surface);
		const action = surfaceFrame(surface, {
			registry,
			surfaceId: 'test-surface',
			host: 'main',
			version: 0,
		});

		expect(registry.focus('test-surface', 'main')).toBe(true);
		expect(document.activeElement).toBe(primaryTarget);

		action.destroy();
	});
});
