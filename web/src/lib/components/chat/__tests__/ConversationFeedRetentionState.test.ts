import { describe, expect, it, vi } from 'vitest';
import { ConversationFeedRetentionState } from '../ConversationFeedRetentionState.svelte';

describe('ConversationFeedRetentionState', () => {
	it('reference-counts leases by key and reason', () => {
		const retention = new ConversationFeedRetentionState();
		const releaseFocus = retention.acquire('row-1', 'focus');
		const releaseTarget = retention.acquire('row-1', 'target');
		expect(retention.retainedKeys).toEqual(['row-1']);

		releaseFocus();
		expect(retention.retainedKeys).toEqual(['row-1']);
		releaseTarget();
		releaseTarget();
		expect(retention.retainedKeys).toEqual([]);
	});

	it('closes every transient registration from a stable snapshot', () => {
		const retention = new ConversationFeedRetentionState();
		const closes: string[] = [];
		let releaseFirst = () => {};
		releaseFirst = retention.acquireTransient('row-1', () => {
			closes.push('first');
			releaseFirst();
		});
		retention.acquireTransient('row-2', () => closes.push('second'));

		retention.closeAllTransients();
		expect(closes).toEqual(['first', 'second']);
	});

	it('continues closing transients after one callback fails', () => {
		const retention = new ConversationFeedRetentionState();
		const second = vi.fn();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		retention.acquireTransient('row-1', () => {
			throw new Error('close failed');
		});
		retention.acquireTransient('row-2', second);

		retention.closeAllTransients();

		expect(second).toHaveBeenCalledOnce();
		expect(console.error).toHaveBeenCalledOnce();
	});

	it('prunes missing stable keys and closes their portals', () => {
		const retention = new ConversationFeedRetentionState();
		const close = vi.fn();
		retention.acquireTransient('removed', close);
		retention.acquire('kept', 'focus');
		retention.prune(['kept']);

		expect(close).toHaveBeenCalledOnce();
		expect(retention.retainedKeys).toEqual(['kept']);
	});

	it('retains the virtual item containing a non-collapsed selection anchor', () => {
		const retention = new ConversationFeedRetentionState();
		const root = document.createElement('div');
		const wrapper = document.createElement('div');
		wrapper.dataset.chatVirtualItem = 'row-1';
		const text = document.createTextNode('selected text');
		wrapper.append(text);
		root.append(wrapper);
		document.body.append(root);
		const selection = document.getSelection();
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 8);
		selection?.removeAllRanges();
		selection?.addRange(range);

		const cleanup = retention.observeSelection({
			get root() {
				return root;
			},
			get visible() {
				return true;
			},
		});
		document.dispatchEvent(new Event('selectionchange'));
		expect(retention.retainedKeys).toEqual(['row-1']);

		selection?.removeAllRanges();
		document.dispatchEvent(new Event('selectionchange'));
		expect(retention.retainedKeys).toEqual([]);
		cleanup();
		root.remove();
	});
});
