import { afterEach, expect, it, vi } from 'vitest';
import { observeMarkdownImage } from '../markdown-image-visibility';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('shares one observer and ancestor style lookup per scroll root during a mount batch', () => {
	const observe = vi.fn();
	const unobserve = vi.fn();
	const disconnect = vi.fn();
	const observer = {
		root: null, rootMargin: '400px', scrollMargin: '0px', thresholds: [0],
		observe, unobserve, disconnect, takeRecords: () => [],
	} satisfies IntersectionObserver;
	const createObserver = vi.fn(function (_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
		return observer;
	});
	vi.stubGlobal('IntersectionObserver', createObserver);
	const computedStyle = vi.spyOn(globalThis, 'getComputedStyle');
	const root = document.createElement('div');
	root.style.overflowY = 'auto';
	const wrapper = document.createElement('div');
	const first = document.createElement('span');
	const second = document.createElement('span');
	root.append(wrapper);
	wrapper.append(first, second);
	document.body.append(root);
	const stopFirst = observeMarkdownImage(first, () => {});
	const stopSecond = observeMarkdownImage(second, () => {});
	try {
		expect(createObserver).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { root, rootMargin: '400px' });
		expect(observe.mock.calls).toEqual([[first], [second]]);
		expect(computedStyle.mock.calls).toEqual([[wrapper], [root]]);
		stopFirst();
		expect(unobserve).toHaveBeenCalledWith(first);
		expect(disconnect).not.toHaveBeenCalled();
		stopSecond();
		expect(disconnect).toHaveBeenCalledOnce();
	} finally {
		stopFirst();
		stopSecond();
		root.remove();
	}
});
