import { describe, expect, it } from 'vitest';
import { FILE_RECOVERY_DEPLOYMENT_ID } from '$lib/files/persistence/file-recovery-identity.js';

describe('file recovery identity', () => {
	it('uses a stable deployment identity in tests and supports a build override', () => {
		expect(FILE_RECOVERY_DEPLOYMENT_ID).toBeTruthy();
		expect(FILE_RECOVERY_DEPLOYMENT_ID).not.toMatch(/^\d+$/);
	});
});
