<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { ConversationFeedProjection } from '../ConversationFeedProjectionState.svelte.js';
	import { ConversationFeedRetentionState } from '../ConversationFeedRetentionState.svelte.js';
	import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';

	interface Exposure {
		controller: ConversationFeedVirtualController;
		viewport(): HTMLDivElement | null;
		hide(): Promise<void>;
		combine(): Promise<void>;
		apply(next: ConversationFeedProjection): Promise<void>;
		show(): Promise<void>;
	}

	interface Props {
		initial: ConversationFeedProjection;
		combined: ConversationFeedProjection;
		onReady(exposure: Exposure): void;
	}

	let { initial, combined, onReady }: Props = $props();
	let current = $state.raw(untrack(() => initial));
	let visible = $state(true);
	let viewportElement: HTMLDivElement | null = $state(null);
	let virtualRoot: HTMLDivElement | null = $state(null);
	const retention = new ConversationFeedRetentionState();
	const controller = new ConversationFeedVirtualController({
		get model() { return current.model; },
		get geometry() { return current.geometry; },
		get projectedDataRevision() { return current.projectedDataRevision; },
		get viewport() { return viewportElement; },
		get virtualRoot() { return virtualRoot; },
		get visible() { return visible; },
		get pinned() { return false; },
		get retention() { return retention; },
	});
	const snapshot = $derived(controller.snapshot);

	const viewportGeometry: Attachment<HTMLElement> = (element) => {
		Object.defineProperties(element, {
			clientHeight: { value: 80 },
			clientWidth: { value: 400 },
			scrollHeight: { get: () => controller.snapshot.sizerSize },
		});
		element.getBoundingClientRect = () => new DOMRect(0, 0, 400, 80);
	};
	const sizerGeometry: Attachment<HTMLElement> = (element) => {
		element.getBoundingClientRect = () =>
			new DOMRect(0, -(viewportElement?.scrollTop ?? 0), 400, snapshot.sizerSize);
	};

	onMount(() => {
		onReady({ controller, viewport: () => viewportElement, hide, combine, apply, show });
	});
	onDestroy(() => controller.destroy());

	async function hide(): Promise<void> {
		controller.prepareForHide();
		visible = false;
		await tick();
	}

	async function combine(): Promise<void> {
		await apply(combined);
	}

	async function apply(next: ConversationFeedProjection): Promise<void> {
		if (!controller.applyProjection({ next, pinned: false, scrollbarDragActive: false })) {
			throw new Error('Expected the projection to apply');
		}
		current = next;
		await tick();
	}

	async function show(): Promise<void> {
		visible = true;
		await controller.restoreHiddenReadingPosition();
		await tick();
	}
</script>

<div
	bind:this={viewportElement}
	style:display={visible ? 'block' : 'none'}
	style:height="80px"
	style:overflow="auto"
	{@attach viewportGeometry}
	{@attach controller.viewport}
>
	<div
		bind:this={virtualRoot}
		style:height={`${snapshot.sizerSize}px`}
		{@attach sizerGeometry}
		{@attach controller.sizer}
	></div>
</div>
