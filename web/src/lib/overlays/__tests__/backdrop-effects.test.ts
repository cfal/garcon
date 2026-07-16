import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE,
	OVERLAY_BACKDROP_EFFECTS_DISABLED,
	OVERLAY_BACKDROP_EFFECTS_ENABLED,
	projectOverlayBackdropEffects,
} from '../backdrop-effects';

describe('overlay backdrop effects projection', () => {
	it('projects enabled and disabled states onto the document root', () => {
		const root = document.createElement('html');

		const cleanupDisabled = projectOverlayBackdropEffects(root, false);
		expect(root.getAttribute(OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE)).toBe(
			OVERLAY_BACKDROP_EFFECTS_DISABLED,
		);
		cleanupDisabled();
		expect(root.hasAttribute(OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE)).toBe(false);

		const cleanupEnabled = projectOverlayBackdropEffects(root, true);
		expect(root.getAttribute(OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE)).toBe(
			OVERLAY_BACKDROP_EFFECTS_ENABLED,
		);
		cleanupEnabled();
	});

	it('keeps the disabled CSS selector aligned with the DOM contract', () => {
		const css = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');

		expect(css).toContain(
			`:root[${OVERLAY_BACKDROP_EFFECTS_ATTRIBUTE}='${OVERLAY_BACKDROP_EFFECTS_DISABLED}'] .transient-backdrop`,
		);
	});
});
