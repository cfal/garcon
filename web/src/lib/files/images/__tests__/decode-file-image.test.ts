import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFileImage } from '../decode-file-image.js';

afterEach(() => vi.restoreAllMocks());

describe('decodeFileImage', () => {
	it('releases its decoder source after extracting dimensions', async () => {
		const decoders: HTMLImageElement[] = [];
		vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (
			this: HTMLImageElement,
		) {
			decoders.push(this);
			Object.defineProperty(this, 'naturalWidth', { value: 1600 });
			Object.defineProperty(this, 'naturalHeight', { value: 900 });
			return Promise.resolve();
		});
		await expect(decodeFileImage('blob:synthetic', new AbortController().signal)).resolves.toEqual({
			width: 1600,
			height: 900,
		});
		expect(decoders[0].getAttribute('src')).toBeNull();
	});

	it('releases an aborted decoder without waiting for decode to finish', async () => {
		let finish!: () => void;
		const decoders: HTMLImageElement[] = [];
		vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (
			this: HTMLImageElement,
		) {
			decoders.push(this);
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const controller = new AbortController();
		const decoded = decodeFileImage('blob:synthetic', controller.signal);
		controller.abort();
		await expect(decoded).rejects.toMatchObject({ name: 'AbortError' });
		expect(decoders[0].getAttribute('src')).toBeNull();
		finish();
	});
});
