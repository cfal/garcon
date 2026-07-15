<script lang="ts">
	import { onDestroy } from 'svelte';

	let {
		value,
		minimum,
		maximum,
		valueText,
		label,
		onResizeStart,
		onResizePreview,
		onResizeCommit,
		onResizeCancel,
		onResizeByKeyboard,
		onReset,
	}: {
		value: number;
		minimum: number;
		maximum: number;
		valueText: string;
		label: string;
		onResizeStart: () => void;
		onResizePreview: (deltaPercentagePoints: number) => void;
		onResizeCommit: () => void;
		onResizeCancel: () => void;
		onResizeByKeyboard: (deltaPercentagePoints: number) => void;
		onReset: () => void;
	} = $props();

	let pointerId = $state<number | null>(null);
	let startX = 0;
	let gridWidth = 0;
	let inlineDirection = 1;
	let previousCursor = '';
	let previousUserSelect = '';

	function startResize(event: PointerEvent): void {
		if (!(event.currentTarget instanceof HTMLElement)) return;
		if (event.isPrimary === false || event.button !== 0) return;
		const grid = event.currentTarget.closest<HTMLElement>('[data-file-tree-column-grid]');
		const measuredWidth = grid?.getBoundingClientRect().width ?? 0;
		if (measuredWidth <= 0) return;

		event.preventDefault();
		pointerId = event.pointerId;
		startX = event.clientX;
		gridWidth = measuredWidth;
		inlineDirection = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
		previousCursor = document.body.style.cursor;
		previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		event.currentTarget.setPointerCapture?.(event.pointerId);
		onResizeStart();
	}

	function previewResize(event: PointerEvent): void {
		if (pointerId !== event.pointerId) return;
		event.preventDefault();
		const delta = (((event.clientX - startX) * inlineDirection) / gridWidth) * 100;
		onResizePreview(delta);
	}

	function stopResize(event: PointerEvent, commit: boolean): void {
		if (pointerId !== event.pointerId) return;
		const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		finishResize(commit);
		if (target?.hasPointerCapture?.(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
	}

	function finishResize(commit: boolean): void {
		if (pointerId === null) return;
		pointerId = null;
		document.body.style.cursor = previousCursor;
		document.body.style.userSelect = previousUserSelect;
		if (commit) onResizeCommit();
		else onResizeCancel();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Home') {
			event.preventDefault();
			onResizeByKeyboard(minimum - value);
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			onResizeByKeyboard(maximum - value);
			return;
		}
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		const step = event.shiftKey ? 5 : 2;
		const rtl = getComputedStyle(event.currentTarget as Element).direction === 'rtl';
		const increaseKey = rtl ? 'ArrowLeft' : 'ArrowRight';
		onResizeByKeyboard(event.key === increaseKey ? step : -step);
	}

	onDestroy(() => finishResize(false));
</script>

<div class="pointer-events-none absolute -inset-y-1 -end-1 z-20 w-2">
	<input
		type="range"
		min={minimum}
		max={maximum}
		{value}
		class="peer pointer-events-auto absolute inset-0 h-full w-full cursor-col-resize touch-none opacity-0"
		aria-label={label}
		aria-valuetext={valueText}
		title={label}
		onpointerdown={startResize}
		onpointermove={previewResize}
		onpointerup={(event) => stopResize(event, true)}
		onpointercancel={(event) => stopResize(event, false)}
		onlostpointercapture={() => finishResize(false)}
		ondblclick={onReset}
		onkeydown={handleKeydown}
	/>
	<span
		class={`pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 bg-border transition-colors peer-hover:bg-interactive-accent peer-focus-visible:bg-ring ${pointerId !== null ? 'bg-interactive-accent' : ''}`}
	></span>
</div>
