import { describe, expect, it, vi } from 'vitest';
import {
	GitReviewDisplaySettingsStore,
	type GitReviewDisplayConsumer,
} from '$lib/git/review/git-review-display-settings.svelte.js';

function consumer(options: { visible?: boolean; composer?: boolean } = {}) {
	let visible = options.visible ?? false;
	let composer = options.composer ?? false;
	const apply = vi.fn();
	const markContextChangeBlocked = vi.fn();
	const value = {
		isVisible: () => visible,
		hasOpenCommentComposer: () => composer,
		markContextChangeBlocked,
		apply,
	} satisfies GitReviewDisplayConsumer;
	return {
		value,
		apply,
		markContextChangeBlocked,
		setVisible(next: boolean) {
			visible = next;
		},
		setComposer(next: boolean) {
			composer = next;
		},
	};
}

describe('GitReviewDisplaySettingsStore', () => {
	it('applies defaults to visible consumers and defers hidden consumers', () => {
		const store = new GitReviewDisplaySettingsStore();
		const visible = consumer({ visible: true });
		const hidden = consumer();

		store.register('visible', visible.value);
		store.register('hidden', hidden.value);

		expect(visible.apply).toHaveBeenCalledWith('unified', 5);
		expect(hidden.apply).not.toHaveBeenCalled();
		hidden.setVisible(true);
		store.reconcile('hidden');
		expect(hidden.apply).toHaveBeenCalledWith('unified', 5);
	});

	it('updates every visible consumer exactly once and reconciles hidden state later', () => {
		const store = new GitReviewDisplaySettingsStore();
		const first = consumer({ visible: true });
		const second = consumer({ visible: true });
		const hidden = consumer();
		store.register('first', first.value);
		store.register('second', second.value);
		store.register('hidden', hidden.value);
		first.apply.mockClear();
		second.apply.mockClear();

		store.setDiffMode('split');
		expect(store.setContextLines(9)).toBe(true);

		expect(first.apply.mock.calls).toEqual([
			['split', 5],
			['split', 9],
		]);
		expect(second.apply.mock.calls).toEqual(first.apply.mock.calls);
		expect(hidden.apply).not.toHaveBeenCalled();
		hidden.setVisible(true);
		store.reconcile('hidden');
		expect(hidden.apply).toHaveBeenCalledWith('split', 9);
	});

	it('reports a comment composer retained in the fullscreen-hidden host', () => {
		const store = new GitReviewDisplaySettingsStore();
		const requester = consumer({ visible: true });
		const blocker = consumer({ composer: true });
		const unrelated = consumer();
		store.register('visible-sidebar-history', requester.value);
		store.register('hidden-main-workbench', blocker.value);
		store.register('unrelated', unrelated.value);

		expect(store.setContextLines(12)).toBe(false);
		expect(store.contextLines).toBe(5);
		expect(requester.markContextChangeBlocked).toHaveBeenCalledOnce();
		expect(blocker.markContextChangeBlocked).toHaveBeenCalledOnce();
		expect(unrelated.markContextChangeBlocked).not.toHaveBeenCalled();
	});

	it('treats the current value as a no-op and unregisters disposed consumers', () => {
		const store = new GitReviewDisplaySettingsStore();
		const entry = consumer({ visible: true, composer: true });
		const unregister = store.register('surface', entry.value);
		entry.apply.mockClear();

		expect(store.setContextLines(5)).toBe(true);
		expect(entry.markContextChangeBlocked).not.toHaveBeenCalled();
		unregister();
		store.setDiffMode('split');
		expect(entry.apply).not.toHaveBeenCalled();
	});

	it('normalizes context lines before publication', () => {
		const store = new GitReviewDisplaySettingsStore();
		const entry = consumer({ visible: true });
		store.register('surface', entry.value);
		entry.apply.mockClear();

		expect(store.setContextLines(-2.6)).toBe(true);
		expect(store.contextLines).toBe(0);
		expect(entry.apply).toHaveBeenCalledWith('unified', 0);
	});
});
