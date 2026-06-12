import { describe, expect, it, vi } from 'vitest';
import { createActionSignal } from '../action-signal';

describe('createActionSignal', () => {
	it('emits to subscribed callbacks and supports unsubscribe', () => {
		const signal = createActionSignal<[string]>();
		const first = vi.fn();
		const second = vi.fn();

		signal.subscribe(first);
		const unsubscribeSecond = signal.subscribe(second);

		signal.emit('one');
		unsubscribeSecond();
		signal.emit('two');

		expect(first).toHaveBeenNthCalledWith(1, 'one');
		expect(first).toHaveBeenNthCalledWith(2, 'two');
		expect(second).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledWith('one');
	});
});
