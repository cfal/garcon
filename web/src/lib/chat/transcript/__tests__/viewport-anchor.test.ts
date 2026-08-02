import { describe, expect, it, vi } from 'vitest';
import {
	captureViewportAnchor,
	restoreEarlierHeightFallback,
	restoreViewportAnchor,
} from '../viewport-anchor.js';

function rect(top: number, height: number): DOMRect {
	return {
		top,
		bottom: top + height,
		left: 0,
		right: 100,
		width: 100,
		height,
		x: 0,
		y: top,
		toJSON: () => ({}),
	};
}

describe('viewport anchors', () => {
	it('captures the first durable row intersecting the viewport', () => {
		const scroller = document.createElement('div');
		const content = document.createElement('div');
		scroller.getBoundingClientRect = () => rect(100, 500);
		Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, configurable: true });
		scroller.scrollTop = 400;

		const above = document.createElement('div');
		above.dataset.chatAnchorId = 'generation-1:10';
		above.getBoundingClientRect = () => rect(60, 40);
		const visible = document.createElement('div');
		visible.dataset.chatAnchorId = 'generation-1:11';
		visible.getBoundingClientRect = () => rect(90, 40);
		content.append(above, visible);

		expect(captureViewportAnchor(scroller, content)).toEqual({
			rowId: 'generation-1:11',
			viewportOffset: -10,
			previousScrollHeight: 1_200,
			previousScrollTop: 400,
			element: visible,
		});
	});

	it('reuses a visible durable row without rescanning the transcript', () => {
		const scroller = document.createElement('div');
		const content = document.createElement('div');
		scroller.getBoundingClientRect = () => rect(100, 500);
		Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
		Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, configurable: true });
		scroller.scrollTop = 410;
		const row = document.createElement('div');
		row.dataset.chatAnchorId = 'generation-1:11';
		row.getBoundingClientRect = () => rect(80, 40);
		content.append(row);
		const scan = vi.spyOn(content, 'querySelectorAll');

		const anchor = captureViewportAnchor(scroller, content, {
			rowId: 'generation-1:11',
			viewportOffset: -10,
			previousScrollHeight: 1_200,
			previousScrollTop: 400,
			element: row,
		});

		expect(anchor).toMatchObject({
			rowId: 'generation-1:11',
			viewportOffset: -20,
			previousScrollTop: 410,
		});
		expect(scan).not.toHaveBeenCalled();
	});

	it('restores a durable row to its previous viewport offset', () => {
		const scroller = document.createElement('div');
		const content = document.createElement('div');
		scroller.getBoundingClientRect = () => rect(100, 500);
		scroller.scrollTop = 400;
		const row = document.createElement('div');
		row.dataset.chatAnchorId = 'generation-1:51';
		let rowTop = 120;
		row.getBoundingClientRect = () => rect(rowTop, 40);
		content.append(row);

		const anchor = {
			rowId: 'generation-1:51',
			viewportOffset: 20,
			previousScrollHeight: 1_000,
			previousScrollTop: 400,
		};
		rowTop += 300;

		expect(restoreViewportAnchor(anchor, scroller, content)).toBe(true);
		expect(scroller.scrollTop).toBe(700);
	});

	it('reports a removed anchor without changing scroll position', () => {
		const scroller = document.createElement('div');
		const content = document.createElement('div');
		scroller.scrollTop = 250;

		expect(
			restoreViewportAnchor(
				{
					rowId: 'missing',
					viewportOffset: 0,
					previousScrollHeight: 500,
					previousScrollTop: 250,
				},
				scroller,
				content,
			),
		).toBe(false);
		expect(scroller.scrollTop).toBe(250);
	});

	it('falls back to the prepended height delta for earlier pages', () => {
		const scroller = document.createElement('div');
		Object.defineProperty(scroller, 'scrollHeight', { value: 900, configurable: true });

		restoreEarlierHeightFallback(
			{
				rowId: 'removed',
				viewportOffset: 0,
				previousScrollHeight: 600,
				previousScrollTop: 200,
			},
			scroller,
		);

		expect(scroller.scrollTop).toBe(500);
	});
});
