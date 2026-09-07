<script lang="ts">
	import {
		clampGitFileTreeWidth,
		MAX_GIT_FILE_TREE_WIDTH,
		MIN_GIT_FILE_TREE_WIDTH,
	} from '$lib/git/surface/git-file-tree-preferences.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitFileTreeResizeHandleProps {
		width: number;
		onResize: (width: number) => void;
		onResizeCommit: (width: number) => void;
	}

	let { width, onResize, onResizeCommit }: GitFileTreeResizeHandleProps = $props();

	function resizeTo(nextWidth: number): void {
		const clampedWidth = clampGitFileTreeWidth(nextWidth);
		onResize(clampedWidth);
		onResizeCommit(clampedWidth);
	}

	function resizeBy(delta: number): void {
		resizeTo(width + delta);
	}

	function startResize(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = width;
		const pointerId = event.pointerId;
		const target = event.currentTarget as HTMLElement;
		const inlineDirection = getComputedStyle(target).direction === 'rtl' ? -1 : 1;
		let pendingWidth = width;
		target.setPointerCapture(pointerId);

		const cleanup = (): void => {
			target.removeEventListener('pointermove', onMove);
			target.removeEventListener('pointerup', onEnd);
			target.removeEventListener('pointercancel', onEnd);
			target.removeEventListener('lostpointercapture', onLostPointerCapture);
		};
		const finish = (): void => {
			cleanup();
			onResizeCommit(pendingWidth);
		};
		const onMove = (moveEvent: PointerEvent): void => {
			pendingWidth = clampGitFileTreeWidth(
				startWidth + (moveEvent.clientX - startX) * inlineDirection,
			);
			onResize(pendingWidth);
		};
		const onEnd = (): void => {
			finish();
			if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
		};
		const onLostPointerCapture = (): void => {
			finish();
		};

		target.addEventListener('pointermove', onMove);
		target.addEventListener('pointerup', onEnd);
		target.addEventListener('pointercancel', onEnd);
		target.addEventListener('lostpointercapture', onLostPointerCapture);
	}
</script>

<input
	type="range"
	min={MIN_GIT_FILE_TREE_WIDTH}
	max={MAX_GIT_FILE_TREE_WIDTH}
	step="1"
	value={width}
	aria-label={m.git_resize_file_tree_pixels({ width })}
	title={m.git_resize_file_tree()}
	data-git-tree-resizer
	class="m-0 h-full w-full min-w-0 touch-none cursor-col-resize appearance-none rounded-none border-none bg-border/60 p-0 transition-colors hover:bg-interactive-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
	onpointerdown={startResize}
	onkeydown={(event) => {
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowDown':
				event.preventDefault();
				resizeBy(-16);
				break;
			case 'ArrowRight':
			case 'ArrowUp':
				event.preventDefault();
				resizeBy(16);
				break;
			case 'Home':
				event.preventDefault();
				resizeTo(MIN_GIT_FILE_TREE_WIDTH);
				break;
			case 'End':
				event.preventDefault();
				resizeTo(MAX_GIT_FILE_TREE_WIDTH);
				break;
		}
	}}
/>

<style>
	input::-webkit-slider-thumb {
		width: 0;
		height: 0;
		appearance: none;
	}

	input::-moz-range-thumb {
		width: 0;
		height: 0;
		border: 0;
		background: transparent;
	}
</style>
