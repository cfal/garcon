<script lang="ts">
	import { onDestroy } from 'svelte';

	interface Props {
		value: number;
		minimum: number;
		maximum: number;
		label: string;
		onPreview: (value: number) => void;
		onCommit: (value: number) => void;
		onCancel: () => void;
		onReset: () => void;
	}

	let { value, minimum, maximum, label, onPreview, onCommit, onCancel, onReset }: Props = $props();

	let pointerId = $state<number | null>(null);
	let startY = 0;
	let startHeight = 0;
	let previewValue = $state<number | null>(null);
	let previousCursor = '';
	let previousUserSelect = '';

	function clamp(next: number): number {
		return Math.min(maximum, Math.max(minimum, Math.round(next)));
	}

	function startResize(event: PointerEvent): void {
		if (!(event.currentTarget instanceof HTMLElement)) return;
		if (event.isPrimary === false || event.button !== 0) return;

		event.preventDefault();
		pointerId = event.pointerId;
		startY = event.clientY;
		startHeight = value;
		previousCursor = document.body.style.cursor;
		previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function previewResize(event: PointerEvent): void {
		if (pointerId !== event.pointerId) return;
		event.preventDefault();
		previewValue = clamp(startHeight + startY - event.clientY);
		onPreview(previewValue);
	}

	function stopResize(event: PointerEvent, commit: boolean): void {
		if (pointerId !== event.pointerId) return;
		const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		finishResize(commit);
		if (target?.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
	}

	function finishResize(commit: boolean): void {
		if (pointerId === null) return;
		const next = previewValue;
		pointerId = null;
		previewValue = null;
		document.body.style.cursor = previousCursor;
		document.body.style.userSelect = previousUserSelect;
		if (commit && next !== null) onCommit(next);
		else onCancel();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Home') {
			event.preventDefault();
			onCommit(clamp(minimum));
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			onCommit(clamp(maximum));
			return;
		}
		const increases = event.key === 'ArrowUp' || event.key === 'ArrowRight';
		const decreases = event.key === 'ArrowDown' || event.key === 'ArrowLeft';
		if (!increases && !decreases) return;
		event.preventDefault();
		const step = event.shiftKey ? 40 : 10;
		onCommit(clamp(value + (increases ? step : -step)));
	}

	onDestroy(() => finishResize(false));
</script>

<div
	data-composer-resize-handle
	class="pointer-events-none absolute -top-1 left-0 right-0 z-40 h-3"
>
	<input
		type="range"
		min={minimum}
		max={maximum}
		step="1"
		value={Math.round(previewValue ?? value)}
		class="peer pointer-events-auto absolute inset-0 m-0 h-full w-full cursor-row-resize touch-none appearance-none opacity-0"
		aria-label={label}
		aria-orientation="vertical"
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
		class={`pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors peer-hover:bg-primary/20 peer-focus-visible:bg-ring ${pointerId !== null ? 'bg-primary/30' : ''}`}
	></span>
</div>
