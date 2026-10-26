<script lang="ts">
	import { untrack } from 'svelte';
	import { AnsiStartupInteractionState } from './ansi-startup-interaction.svelte.js';
	import {
		PLASMA_CELL_WIDTH,
		PLASMA_CELL_HEIGHT,
		createPlasmaScene,
		drawPlasma,
		plasmaGrid,
	} from '$lib/theme/ansi-plasma.js';

	const STARTUP_DURATION_MS = 2600;
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
	const interaction = new AnsiStartupInteractionState(dismiss);
	let presented = false;
	const visible = $derived(
		initiallyEligible && ((!dismissed && workspaceReady) || interaction.hasActiveTouches),
	);

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
		return interaction.attach(root);
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
