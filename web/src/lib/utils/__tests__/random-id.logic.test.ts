import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRandomId } from '../random-id';

const nativeGetRandomValues = crypto.getRandomValues;

afterEach(() => vi.restoreAllMocks());

describe('createRandomId', () => {
	it('creates an RFC 4122 v4 identifier without randomUUID', () => {
		const getRandomValues = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
			const bytes = array as Uint8Array;
			for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
			return array;
		});

		expect(createRandomId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
		expect(getRandomValues).toHaveBeenCalledOnce();
	});

	it('leaves native randomness available to other logic tests', () => {
		expect(crypto.getRandomValues).toBe(nativeGetRandomValues);
		expect(createRandomId()).not.toBe(createRandomId());
	});
});
