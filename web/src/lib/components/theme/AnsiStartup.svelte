<script lang="ts">
	import { untrack } from 'svelte';
	import {
		PLASMA_CELL_WIDTH,
		PLASMA_CELL_HEIGHT,
		createPlasmaScene,
		drawPlasma,
		plasmaGrid,
	} from '$lib/theme/ansi-plasma.js';

	const STARTUP_DURATION_MS = 2600;
	const REPEAT_GUARD_MS = 400;
	const MOUSE_SLOP_PX = 5;
	const TOUCH_SLOP_PX = 32;
	const FRAME_INTERVAL_MS = 1000 / 16;

	let {
		enabled,
		workspaceReady,
		reduceMotion,
	}: { enabled: boolean; workspaceReady: boolean; reduceMotion: boolean } = $props();
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const forcedColors = window.matchMedia('(forced-colors: active)');
	const initiallyEligible = untrack(
		() => enabled && !reduceMotion && !motion.matches && !forcedColors.matches && !document.hidden,
	);
	const startupDeadline = performance.now() + STARTUP_DURATION_MS;
	let dismissed = $state(false);
	let canvas = $state<HTMLCanvasElement>();
	let root = $state<HTMLDivElement>();
	let activeTouches = $state<number[]>([]);
	let repeatGuardOrigin = $state<{ x: number; y: number; radius: number }>();
	let presented = false;
	const visible = $derived(
		initiallyEligible && ((!dismissed && workspaceReady) || activeTouches.length > 0),
	);

	function consume(event: Event) {
		event.preventDefault();
		event.stopPropagation();
	}

	export function dismiss() {
		dismissed = true;
	}

	$effect(() => {
		if (!initiallyEligible || dismissed) return;
		const timeout = window.setTimeout(dismiss, Math.max(0, startupDeadline - performance.now()));
		const visibilityChanged = () => {
			if (document.hidden) dismiss();
		};
		const motionChanged = () => {
			if (motion.matches || forcedColors.matches) dismiss();
		};
		document.addEventListener('visibilitychange', visibilityChanged);
		motion.addEventListener('change', motionChanged);
		forcedColors.addEventListener('change', motionChanged);
		return () => {
			window.clearTimeout(timeout);
			document.removeEventListener('visibilitychange', visibilityChanged);
			motion.removeEventListener('change', motionChanged);
			forcedColors.removeEventListener('change', motionChanged);
		};
	});

	$effect(() => {
		if (reduceMotion || !enabled) dismiss();
		if (workspaceReady) presented = true;
		else if (presented) dismiss();
	});

	$effect(() => {
		if (!root || !visible) return;
		const target = root;
		const preserveFocus = (event: MouseEvent) => event.preventDefault();
		const dismissFromInteraction = (event: Event) => {
			consume(event);
			if (event.type === 'click' && event instanceof MouseEvent) {
				repeatGuardOrigin = { x: event.clientX, y: event.clientY, radius: MOUSE_SLOP_PX };
			}
			dismiss();
		};
		const beginTouch = (event: TouchEvent) => {
			consume(event);
			activeTouches = [
				...new Set([
					...activeTouches,
					...Array.from(event.changedTouches, (touch) => touch.identifier),
				]),
			];
		};
		const finishTouch = (event: TouchEvent) => {
			consume(event);
			const finished = Array.from(event.changedTouches, (touch) => touch.identifier);
			activeTouches = activeTouches.filter((id) => !finished.includes(id));
			if (activeTouches.length > 0) return;
			const point = event.changedTouches[event.changedTouches.length - 1];
			if (point) {
				repeatGuardOrigin = { x: point.clientX, y: point.clientY, radius: TOUCH_SLOP_PX };
			}
			dismiss();
		};
		target.addEventListener('mousedown', preserveFocus);
		target.addEventListener('click', dismissFromInteraction);
		target.addEventListener('wheel', dismissFromInteraction, { passive: false });
		// The overlay owns the whole gesture, including the touch pointerup before touchend.
		target.addEventListener('touchstart', beginTouch, { passive: false });
		target.addEventListener('touchend', finishTouch, { passive: false });
		target.addEventListener('touchcancel', finishTouch, { passive: false });
		return () => {
			target.removeEventListener('mousedown', preserveFocus);
			target.removeEventListener('click', dismissFromInteraction);
			target.removeEventListener('wheel', dismissFromInteraction);
			target.removeEventListener('touchstart', beginTouch);
			target.removeEventListener('touchend', finishTouch);
			target.removeEventListener('touchcancel', finishTouch);
		};
	});

	$effect(() => {
		if (!repeatGuardOrigin) return;
		let origin = repeatGuardOrigin;
		const heldPointers = new Set<number>();
		const releasedPointers = new Set<number>();
		let timeout: number;
		const armExpiry = () => {
			window.clearTimeout(timeout);
			timeout = window.setTimeout(() => {
				repeatGuardOrigin = undefined;
			}, REPEAT_GUARD_MS);
		};
		const nearOrigin = (x: number, y: number, radius: number) =>
			Math.abs(x - origin.x) <= radius && Math.abs(y - origin.y) <= radius;
		// The second click belongs to the dismissed intro, not the newly exposed workspace.
		const consumeRepeat = (event: MouseEvent) => {
			const pointer = event instanceof PointerEvent ? event : undefined;
			let radius = origin.radius;
			if (pointer) {
				radius = pointer.pointerType === 'mouse' ? MOUSE_SLOP_PX : TOUCH_SLOP_PX;
			} else if (event.type === 'mousedown') {
				radius = MOUSE_SLOP_PX;
			}
			if (pointer && event.type === 'pointerdown') {
				releasedPointers.delete(pointer.pointerId);
				if (!nearOrigin(event.clientX, event.clientY, radius)) return;
				heldPointers.add(pointer.pointerId);
				window.clearTimeout(timeout);
			} else if (pointer && (event.type === 'pointerup' || event.type === 'pointercancel')) {
				if (!heldPointers.delete(pointer.pointerId)) return;
				if (event.type === 'pointerup') {
					releasedPointers.add(pointer.pointerId);
					origin = { x: event.clientX, y: event.clientY, radius };
				} else {
					releasedPointers.delete(pointer.pointerId);
				}
				if (heldPointers.size === 0) armExpiry();
			} else {
				let ownedClick = false;
				if (event.type === 'click') {
					if (pointer) {
						ownedClick = releasedPointers.delete(pointer.pointerId);
					} else if (
						releasedPointers.size > 0 &&
						nearOrigin(event.clientX, event.clientY, radius)
					) {
						releasedPointers.clear();
						ownedClick = true;
					}
				}
				if (!ownedClick) {
					if (event.type !== 'mousedown' && event.detail < 2) return;
					if (!nearOrigin(event.clientX, event.clientY, radius)) return;
				}
			}
			consume(event);
		};
		const consumeRepeatTouch = (event: TouchEvent) => {
			const point = event.changedTouches[0];
			if (!point || !nearOrigin(point.clientX, point.clientY, TOUCH_SLOP_PX)) return;
			consume(event);
		};
		window.addEventListener('pointerdown', consumeRepeat, true);
		window.addEventListener('pointerup', consumeRepeat, true);
		window.addEventListener('pointercancel', consumeRepeat, true);
		window.addEventListener('mousedown', consumeRepeat, true);
		window.addEventListener('click', consumeRepeat, true);
		window.addEventListener('dblclick', consumeRepeat, true);
		window.addEventListener('touchstart', consumeRepeatTouch, { capture: true, passive: false });
		armExpiry();
		return () => {
			window.clearTimeout(timeout);
			window.removeEventListener('pointerdown', consumeRepeat, true);
			window.removeEventListener('pointerup', consumeRepeat, true);
			window.removeEventListener('pointercancel', consumeRepeat, true);
			window.removeEventListener('mousedown', consumeRepeat, true);
			window.removeEventListener('click', consumeRepeat, true);
			window.removeEventListener('dblclick', consumeRepeat, true);
			window.removeEventListener('touchstart', consumeRepeatTouch, true);
		};
	});

	$effect(() => {
		if (!canvas || dismissed) return;
		const target = canvas;
		const context = target.getContext('2d');
		if (!context) {
			dismiss();
			return;
		}
		const scene = createPlasmaScene();
		let grid = plasmaGrid(window.innerWidth, window.innerHeight);
		const resize = () => {
			grid = plasmaGrid(window.innerWidth, window.innerHeight);
			target.width = grid.columns * PLASMA_CELL_WIDTH;
			target.height = grid.rows * PLASMA_CELL_HEIGHT;
			context.font = `${PLASMA_CELL_HEIGHT}px "Departure Mono", monospace`;
			context.textBaseline = 'top';
		};
		resize();
		window.addEventListener('resize', resize);
		const start = performance.now();
		let lastFrame = -Infinity;
		let request = 0;
		const paint = (now: number) => {
			if (now >= startupDeadline) {
				dismiss();
				return;
			}
			if (now - lastFrame >= FRAME_INTERVAL_MS) {
				drawPlasma(context, grid.columns, grid.rows, (now - start) / 1000, scene);
				lastFrame = now;
			}
			request = requestAnimationFrame(paint);
		};
		paint(start);
		return () => {
			cancelAnimationFrame(request);
			window.removeEventListener('resize', resize);
		};
	});
</script>

{#if visible}
	<div bind:this={root} class="ansi-startup" data-ansi-startup aria-hidden="true">
		<canvas bind:this={canvas}></canvas>
		<div class="ansi-startup-wordmark">GARCON<span>_</span></div>
	</div>
{/if}

<style>
	.ansi-startup {
		position: fixed;
		inset: 0;
		z-index: 100;
		pointer-events: auto;
		cursor: pointer;
		background: hsl(var(--background));
		contain: strict;
	}
	canvas {
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}
	.ansi-startup-wordmark {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font:
			66px/1 'Departure Mono',
			monospace;
		color: hsl(var(--foreground));
		text-shadow: 6px 6px 0 hsl(var(--background));
	}
	.ansi-startup-wordmark span {
		color: hsl(var(--primary));
	}
	@media (max-width: 480px) {
		.ansi-startup-wordmark {
			font-size: 44px;
		}
	}
	@media (prefers-reduced-motion: reduce), (forced-colors: active) {
		.ansi-startup {
			display: none;
		}
	}
</style>
