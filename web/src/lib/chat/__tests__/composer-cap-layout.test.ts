import { describe, it, expect } from 'vitest';
import { composerCapReservation } from '../composer-cap-layout';

describe('composerCapReservation', () => {
	it('reserves nothing when no cap is shown', () => {
		expect(composerCapReservation(false, false)).toEqual({ feed: false, queue: false });
		expect(composerCapReservation(false, true)).toEqual({ feed: false, queue: false });
	});

	it('reserves on the feed when a cap is shown without a visible queue', () => {
		expect(composerCapReservation(true, false)).toEqual({ feed: true, queue: false });
	});

	it('reserves on the queue panel when a cap is shown with a visible queue', () => {
		expect(composerCapReservation(true, true)).toEqual({ feed: false, queue: true });
	});
});
