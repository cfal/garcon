<script lang="ts">
	import { onDestroy } from 'svelte';

	let {
		value,
		minimum,
		maximum,
		label,
		onPreview,
		onCommit,
		onCancel,
		onReset,
	}: {
		value: number;
		minimum: number;
		maximum: number;
		label: string;
		onPreview: (value: number) => void;
		onCommit: (value: number) => void;
		onCancel: () => void;
		onReset: () => void;
	} = $props();

	let pointerId = $state<number | null>(null);
	let startX = 0;
	let startWidth = 0;
	let inlineDirection = 1;
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
		startX = event.clientX;
		startWidth = value;
		inlineDirection = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
		previousCursor = document.body.style.cursor;
		previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function previewResize(event: PointerEvent): void {
		if (pointerId !== event.pointerId) return;
		previewValue = clamp(startWidth + (startX - event.clientX) * inlineDirection);
		onPreview(previewValue);
	}

	function stopResize(event: PointerEvent, commit: boolean): void {
		if (pointerId !== event.pointerId) return;
		const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		finish(commit);
		if (target && target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
	}

	function finish(commit: boolean): void {
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
			onReset();
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			onCommit(clamp(maximum));
			return;
		}
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		const step = event.shiftKey ? 40 : 10;
		const rtl = getComputedStyle(event.currentTarget as Element).direction === 'rtl';
		const direction = event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? 1 : -1;
		onCommit(clamp(value + step * direction));
	}

	onDestroy(() => finish(false));
</script>

<div class="pointer-events-none absolute inset-y-0 -start-1.5 z-50 w-3">
	<input
		type="range"
		min={minimum}
		max={Math.round(maximum)}
		value={Math.round(previewValue ?? value)}
		class="peer pointer-events-auto absolute inset-0 h-full w-full cursor-col-resize touch-none opacity-0"
		aria-label={label}
		title={label}
		onpointerdown={startResize}
		onpointermove={previewResize}
		onpointerup={(event) => stopResize(event, true)}
		onpointercancel={(event) => stopResize(event, false)}
		onlostpointercapture={() => finish(false)}
		ondblclick={onReset}
		onkeydown={handleKeydown}
	/>
	<span
		class={`pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 transition-colors peer-hover:bg-primary/20 peer-focus-visible:bg-ring ${pointerId !== null ? 'bg-primary/30' : 'bg-transparent'}`}
	></span>
</div>
