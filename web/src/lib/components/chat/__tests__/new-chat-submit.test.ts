import { describe, expect, it } from 'vitest';
import { canSubmitNewChat } from '../new-chat-submit';

describe('canSubmitNewChat', () => {
	it('returns true only for valid path and non-empty message', () => {
		expect(canSubmitNewChat('/tmp/project', 'valid', 'start')).toBe(true);
		expect(canSubmitNewChat('   /tmp/project   ', 'valid', 'start')).toBe(true);
		expect(canSubmitNewChat('/tmp/project', 'valid', '')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'valid', '   ')).toBe(false);
		expect(canSubmitNewChat('', 'valid', 'start')).toBe(false);
		expect(canSubmitNewChat('   ', 'valid', 'start')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'idle', 'start')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'checking', 'start')).toBe(false);
		expect(canSubmitNewChat('/tmp/project', 'invalid', 'start')).toBe(false);
	});
});
