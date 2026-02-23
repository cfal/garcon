import { describe, expect, it } from 'vitest';
import { canSubmitNewChat } from '../new-chat-submit';

describe('canSubmitNewChat', () => {
	it('returns true only for valid status and non-empty trimmed path', () => {
		expect(canSubmitNewChat('/tmp/project', 'valid')).toBe(true);
		expect(canSubmitNewChat('   /tmp/project   ', 'valid')).toBe(true);
		expect(canSubmitNewChat('', 'valid')).toBe(false);
		expect(canSubmitNewChat('   ', 'valid')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'idle')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'checking')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'invalid')).toBe(false);
	});
});
