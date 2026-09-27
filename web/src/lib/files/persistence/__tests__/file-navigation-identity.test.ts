import { describe, expect, it } from 'vitest';
import { FILE_NAVIGATION_DEPLOYMENT_ID } from '$lib/files/persistence/file-navigation-identity.js';

describe('file navigation identity', () => {
	it('uses a stable deployment identity in tests and supports a build override', () => {
		expect(FILE_NAVIGATION_DEPLOYMENT_ID).toBeTruthy();
		expect(FILE_NAVIGATION_DEPLOYMENT_ID).not.toMatch(/^\d+$/);
	});
});
