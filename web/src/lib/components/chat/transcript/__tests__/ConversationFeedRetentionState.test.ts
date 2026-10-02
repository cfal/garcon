import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationFeedRetentionState } from '../ConversationFeedRetentionState.svelte';

describe('ConversationFeedRetentionState', () => {
	afterEach(() => vi.restoreAllMocks());

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
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		consoleError.mockClear();
		retention.acquireTransient('row-1', () => {
			throw new Error('close failed');
		});
		retention.acquireTransient('row-2', second);

		retention.closeAllTransients();

		expect(second).toHaveBeenCalledOnce();
		expect(consoleError).toHaveBeenCalledOnce();
		expect(retention.retainedKeys).toEqual([]);
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

	it('continues pruning and releases failed transient closures', () => {
		const retention = new ConversationFeedRetentionState();
		const second = vi.fn();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		consoleError.mockClear();
		retention.acquireTransient('removed-1', () => {
			throw new Error('close failed');
		});
		retention.acquireTransient('removed-2', second);
		retention.acquire('kept', 'focus');

		retention.prune(['kept']);

		expect(second).toHaveBeenCalledOnce();
		expect(consoleError).toHaveBeenCalledOnce();
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

	it('retains every virtual item intersecting a cross-row selection', () => {
		const retention = new ConversationFeedRetentionState();
		const root = document.createElement('div');
		const first = document.createElement('div');
		const second = document.createElement('div');
		first.dataset.chatVirtualItem = 'assistant';
		second.dataset.chatVirtualItem = 'tool';
		const firstText = document.createTextNode('response');
		const secondText = document.createTextNode('command');
		first.append(firstText);
		second.append(secondText);
		root.append(first, second);
		document.body.append(root);
		const selection = document.getSelection();
		const range = document.createRange();
		range.setStart(firstText, 0);
		range.setEnd(secondText, secondText.length);
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
		expect(retention.retainedKeys).toEqual(['assistant', 'tool']);

		selection?.removeAllRanges();
		document.dispatchEvent(new Event('selectionchange'));
		expect(retention.retainedKeys).toEqual([]);
		cleanup();
		root.remove();
	});

	it('retains feed rows when a selection begins outside the feed', () => {
		const retention = new ConversationFeedRetentionState();
		const container = document.createElement('section');
		const heading = document.createElement('h2');
		const root = document.createElement('div');
		const wrapper = document.createElement('div');
		wrapper.dataset.chatVirtualItem = 'tool';
		const headingText = document.createTextNode('Conversation');
		const toolText = document.createTextNode('command');
		heading.append(headingText);
		wrapper.append(toolText);
		root.append(wrapper);
		container.append(heading, root);
		document.body.append(container);
		const selection = document.getSelection();
		const range = document.createRange();
		range.setStart(headingText, 0);
		range.setEnd(toolText, toolText.length);
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
		expect(retention.retainedKeys).toEqual(['tool']);

		selection?.removeAllRanges();
		document.dispatchEvent(new Event('selectionchange'));
		expect(retention.retainedKeys).toEqual([]);
		cleanup();
		container.remove();
	});
});
