import { afterEach, expect, it, vi } from 'vitest';
import { settleConversationTarget } from '../conversation-feed-virtual-runtime.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each([0, 40])(
	'does not report a zero-height hidden row as a visible target (%i px)',
	async (height) => {
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			queueMicrotask(() => callback(0));
			return 1;
		});
		const root = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'view:4';
		root.append(row);
		vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
		vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 280, 800, height));
		const result = await settleConversationTarget({
			root: () => root,
			viewport: () => root,
			rowId: 'view:4',
			align: 'center',
			isCurrent: () => true,
			isReady: () => true,
			scrollBy: vi.fn(),
			onSettledNode: vi.fn(),
		});
		expect(result).toBe(height === 0 ? 'target-missing' : 'completed');
	},
);
