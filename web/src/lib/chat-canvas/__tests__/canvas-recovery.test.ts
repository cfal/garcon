import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserCanvasRecovery } from '../canvas-recovery';
import { canvas } from './canvas-fixtures';

function storage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		key: (index) => [...entries.keys()][index] ?? null,
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => {
			entries.set(key, value);
		},
		removeItem: (key) => {
			entries.delete(key);
		},
		clear: () => entries.clear(),
	} satisfies Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe('canvas recovery ownership', () => {
	it('keeps one tab’s pending edits when another tab saves the same canvas', () => {
		const firstTab = storage();
		const secondTab = storage();
		vi.stubGlobal('localStorage', storage());
		vi.stubGlobal('sessionStorage', firstTab);
		const first = canvas({ ...canvas().content, title: 'First tab' });
		browserCanvasRecovery.write(first);
		vi.stubGlobal('sessionStorage', secondTab);
		const second = canvas({ ...canvas().content, title: 'Second tab' });
		browserCanvasRecovery.write(second);
		vi.stubGlobal('sessionStorage', firstTab);
		expect(browserCanvasRecovery.read(first.id)).toEqual(first);
		browserCanvasRecovery.remove(first.id);
		vi.stubGlobal('sessionStorage', secondTab);
		expect(browserCanvasRecovery.read(second.id)).toEqual(second);
	});

	it('enumerates surviving drafts without reading unrelated tab storage', () => {
		const tab = storage();
		vi.stubGlobal('sessionStorage', tab);
		tab.setItem('unrelated-preference', 'not JSON');
		browserCanvasRecovery.write(canvas());
		expect(browserCanvasRecovery.list()).toEqual([canvas()]);
		browserCanvasRecovery.remove('board');
		expect(browserCanvasRecovery.list()).toEqual([]);
		expect(tab.getItem('unrelated-preference')).toBe('not JSON');
	});
});
