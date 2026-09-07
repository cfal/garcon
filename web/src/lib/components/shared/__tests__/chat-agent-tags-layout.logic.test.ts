import { describe, expect, it } from 'vitest';
import { selectFittingTagPrefix } from '../chat-agent-tags-layout.js';

describe('selectFittingTagPrefix', () => {
	it('reserves a visible and accurate overflow affordance across two rows', () => {
		const input = {
			agentWidth: 48,
			tagWidths: [116, 116, 116, 116, 116, 116],
			totalTagCount: 7,
			overflowWidths: new Map([
				[1, 18],
				[2, 18],
				[3, 18],
				[4, 18],
				[5, 18],
				[6, 18],
				[7, 18],
			]),
			gap: 4,
			maxRows: 2,
		};

		expect(selectFittingTagPrefix({ ...input, availableWidth: 240 })).toBe(2);
		expect(selectFittingTagPrefix({ ...input, availableWidth: 300 })).toBe(4);
	});

	it('omits overflow space when every tag fits', () => {
		expect(selectFittingTagPrefix({
			availableWidth: 240,
			agentWidth: 48,
			tagWidths: [48, 48],
			totalTagCount: 2,
			overflowWidths: new Map(),
			gap: 4,
			maxRows: 2,
		})).toBe(2);
	});
});
