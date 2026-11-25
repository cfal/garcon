import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCanvasRecovery } from '../canvas-recovery';
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

const browserCanvasRecovery = createBrowserCanvasRecovery(() => 'viewer-a');

describe('canvas recovery ownership', () => {
	it('keeps separate viewer drafts and fences a late write by the previous viewer', () => {
		vi.stubGlobal('sessionStorage', storage());
		let viewer = 'viewer-a';
		const first = createBrowserCanvasRecovery(() => viewer);
		first.write(canvas({ ...canvas().content, title: 'Viewer A' }));
		viewer = 'viewer-b';
		const second = createBrowserCanvasRecovery(() => viewer);
		expect(first.list()).toEqual([]);
		expect(second.read('board')).toBeNull();
		second.write(canvas({ ...canvas().content, title: 'Viewer B' }));
		expect(() => first.write(canvas())).toThrow('unavailable');
		first.remove('board');
		expect(second.read('board')?.content.title).toBe('Viewer B');
		viewer = 'viewer-a';
		expect(first.read('board')?.content.title).toBe('Viewer A');
	});

	it('bounds entries without silently evicting unsaved work', () => {
		vi.stubGlobal('sessionStorage', storage());
		for (let i = 0; i < 32; i += 1) browserCanvasRecovery.write({ ...canvas(), id: `board-${i}` });
		expect(() => browserCanvasRecovery.write(canvas())).toThrow('full');
		expect(browserCanvasRecovery.list()).toHaveLength(32);
		browserCanvasRecovery.write({ ...canvas(), id: 'board-0' });
		expect(browserCanvasRecovery.list()).toHaveLength(32);
	});

	it('does not read or claim an unowned draft', () => {
		const tab = storage();
		vi.stubGlobal('sessionStorage', tab);
		const key = 'chat-canvas-recovery-v1:board';
		const draft = JSON.stringify(canvas());
		tab.setItem(key, draft);
		expect(browserCanvasRecovery.list()).toEqual([]);
		expect(browserCanvasRecovery.read('board')).toBeNull();
		browserCanvasRecovery.write(canvas());
		browserCanvasRecovery.remove('board');
		expect(tab.getItem(key)).toBe(draft);
	});

	it('removes malformed drafts without hiding valid drafts', () => {
		const tab = storage();
		vi.stubGlobal('sessionStorage', tab);
		tab.setItem('chat-canvas-recovery-v1:viewer:viewer-a:bad', '{');
		browserCanvasRecovery.write(canvas());
		browserCanvasRecovery.write({ ...canvas(), id: 'second' });
		expect(browserCanvasRecovery.list().map((draft) => draft.id)).toEqual(['board', 'second']);
		expect(tab.getItem('chat-canvas-recovery-v1:viewer:viewer-a:bad')).toBeNull();
	});

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
