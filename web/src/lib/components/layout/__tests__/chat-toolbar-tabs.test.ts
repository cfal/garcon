import { describe, expect, it } from 'vitest';
import { getChatToolbarTabs } from '../chat-toolbar-tabs';

describe('getChatToolbarTabs', () => {
	it('omits pull requests when gh is unavailable', () => {
		expect(getChatToolbarTabs({ pullRequestsAvailable: false }).map((tab) => tab.id)).toEqual([
			'chat',
			'git',
			'files',
			'shell',
		]);
	});

	it('includes pull requests when gh is available', () => {
		expect(getChatToolbarTabs({ pullRequestsAvailable: true }).map((tab) => tab.id)).toEqual([
			'chat',
			'git',
			'pull-requests',
			'files',
			'shell',
		]);
	});
});
