import { describe, expect, it, vi } from 'vitest';
import { WsConnection } from '$lib/ws/connection.svelte';
import { PullRequestReviewsRouter } from '../pull-request-reviews-router.js';

describe('PullRequestReviewsRouter', () => {
	it('passes valid review invalidations to the store and ignores malformed ones', () => {
		const connection = new WsConnection();
		const invalidate = vi.fn();
		const router = new PullRequestReviewsRouter(connection, { invalidate });
		router.start();
		connection.messages.push(...[
			{ type: 'pull-request-reviews-invalidated', revision: 3 },
			{ type: 'pull-request-reviews-invalidated', revision: -1 },
			{ type: 'pull-request-reviews-invalidated', revision: 4, extra: true },
			{ type: 'tickets-invalidated', revision: 5 },
		].map((data) => ({ data, timestamp: 0 })));
		router.tick();
		expect(invalidate.mock.calls).toEqual([[3]]);
		router.destroy();
		connection.disconnect();
	});
});
