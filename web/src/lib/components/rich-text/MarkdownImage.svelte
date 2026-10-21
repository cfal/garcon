<script lang="ts">
	import { onDestroy } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import { getFileImages, hasFileImages } from '$lib/context/file-images-context.js';
	import {
		getMarkdownLinkActions,
		hasMarkdownLinkActions,
	} from '$lib/context/markdown-link-actions-context.js';
	import {
		FileImageCache,
		type FileImageLease,
	} from '$lib/files/images/file-image-cache.svelte.js';
	import type { ResolveMarkdownImageFile } from '$lib/chat/file-links/file-link-resolver.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		href,
		title,
		text = '',
		resolveImageFile,
		onOpen,
	}: {
		href?: string;
		title?: string;
		text?: string;
		resolveImageFile?: ResolveMarkdownImageFile;
		onOpen?: (href: string) => void;
	} = $props();

	const ownsCache = !hasFileImages();
	const cache = ownsCache ? new FileImageCache({ budgetBytes: 0 }) : getFileImages();
	const registerLinkAction = hasMarkdownLinkActions() ? getMarkdownLinkActions() : undefined;
	onDestroy(() => {
		clearRetryFocus?.();
		if (ownsCache) cache.destroy();
	});

	const externalSource = $derived(href && /^(https?:)?\/\//i.test(href) ? href : undefined);
	const file = $derived(href && !externalSource ? resolveImageFile?.(href) : null);
	const executorId = $derived(file?.executorId);
	const executorContextKey = $derived(file?.executorContextKey);
	const projectPath = $derived(file?.projectPath);
	const filePath = $derived(file?.filePath);
	let retryVersion = $state(0);
	// Scalar dependencies keep equivalent resolver results on the same loading attempt.
	const attempt = $derived({
		externalSource,
		executorId,
		executorContextKey,
		projectPath,
		filePath,
		retryVersion,
	});
	let requestedRetry = $state.raw<typeof attempt>();
	let loaded = $state.raw<typeof attempt>();
	let focusAttempt = $state.raw<typeof attempt>();
	let clearRetryFocus: (() => void) | undefined;
	let element = $state<HTMLSpanElement>();
	let retryButton = $state<HTMLButtonElement | null>(null);
	const retryFocusTarget = $derived(element?.closest('a') ?? element);
	// Authored image links retain their destination instead of nesting another control.
	const canOpen = $derived(Boolean(file && onOpen && element && !element.closest('a, button')));
	const imageName = $derived(text || title || filePath || '');
	const openLabel = $derived(m.image_open({ name: imageName }));
	const retryLabel = $derived(m.image_retry({ name: imageName }).trim());
	const canRetry = $derived(
		Boolean(externalSource || (file && executorContextKey && cache.available)),
	);
	let held = $state.raw<{ attempt: typeof attempt; lease: FileImageLease }>();
	let failed = $state.raw<typeof attempt>();
	const lease = $derived(held?.attempt === attempt ? held.lease : undefined);
	const source = $derived(externalSource ?? lease?.image?.url);
	const externalRetryPending = $derived(
		Boolean(externalSource && requestedRetry === attempt && loaded !== attempt),
	);
	const unavailable = $derived(
		failed === attempt ||
			(!externalSource &&
				(!executorId || !projectPath || !filePath || !cache.available || lease?.failed)),
	);
	const retryFailed = $derived(unavailable && requestedRetry === attempt && loaded !== attempt);

	$effect(() => {
		const current = attempt;
		const target = element;
		void cache.generation;
		if (
			!target ||
			!cache.available ||
			!current.executorId ||
			!current.executorContextKey ||
			!current.projectPath ||
			!current.filePath
		)
			return;
		const acquired = cache.acquire({
			executorId: current.executorId,
			executorContextKey: current.executorContextKey,
			projectPath: current.projectPath,
			filePath: current.filePath,
		});
		held = { attempt: current, lease: acquired };
		let started = false;
		let observer: IntersectionObserver | undefined;

		function load(): void {
			if (started) return;
			started = true;
			observer?.disconnect();
			void acquired.ensureCurrent();
		}

		if (current === requestedRetry || typeof IntersectionObserver === 'undefined') {
			load();
		} else {
			observer = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) load();
				},
				{ rootMargin: '50px' },
			);
			observer.observe(target);
		}
		return () => {
			started = true;
			observer?.disconnect();
			acquired.release();
		};
	});

	$effect(() => {
		if (element) return registerLinkAction?.(element, retryControl);
	});

	$effect(() => {
		if (
			retryFailed &&
			focusAttempt === attempt &&
			retryButton &&
			document.activeElement === retryFocusTarget
		) {
			retryButton.focus({ preventScroll: true });
			clearRetryFocus?.();
		}
	});

	function retry(): void {
		if (!unavailable || !canRetry) return;
		const target = retryFocusTarget;
		const preserveFocus = document.activeElement === retryButton;
		clearRetryFocus?.();
		retryVersion += 1;
		requestedRetry = attempt;
		if (!target || !preserveFocus) return;

		const focusTarget = target;
		const current = attempt;
		// Only explicit retries need a focus stop; ordinary image clicks must not expand messages.
		const needsTabIndex = !focusTarget.matches('a[href], [tabindex]');
		if (needsTabIndex) focusTarget.setAttribute('tabindex', '-1');
		function releaseFocus(): void {
			focusTarget.removeEventListener('blur', onBlur);
			if (needsTabIndex) focusTarget.removeAttribute('tabindex');
			if (focusAttempt === current) focusAttempt = undefined;
			if (clearRetryFocus === releaseFocus) clearRetryFocus = undefined;
		}
		function onBlur(): void {
			if (document.activeElement !== focusTarget) releaseFocus();
		}
		focusAttempt = current;
		clearRetryFocus = releaseFocus;
		focusTarget.addEventListener('blur', onBlur);
		focusTarget.focus({ preventScroll: true });
	}

	function failImage(current: typeof attempt, url: string): void {
		if (current !== attempt) return;
		if (externalSource) failed = current;
		else lease?.reportDisplayError(url);
	}

	function stopParentContextTriggerGesture(event: PointerEvent | MouseEvent): void {
		event.stopPropagation();
	}
</script>

{#snippet thumbnail(current: typeof attempt, url: string)}
	<img
		loading={requestedRetry === current ? 'eager' : 'lazy'}
		src={url}
		alt={text}
		{title}
		decoding="async"
		referrerpolicy="no-referrer"
		style:display={externalRetryPending ? 'none' : undefined}
		onload={() => {
			if (current === attempt) loaded = current;
		}}
		onerror={(event) => failImage(current, event.currentTarget.getAttribute('src') ?? '')}
	/>
{/snippet}

{#snippet loading()}
	<span
		class="placeholder text-muted-foreground"
		role="status"
		aria-label={m.image_loading()}
		aria-busy="true"
	>
		<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
	</span>
{/snippet}

{#snippet retryControl()}
	{#if unavailable && canRetry}
		<Button
			bind:ref={retryButton}
			variant="ghost"
			size="icon-sm"
			class={registerLinkAction ? 'ml-1 align-middle' : ''}
			aria-label={retryLabel}
			title={retryLabel}
			onpointerdowncapture={stopParentContextTriggerGesture}
			oncontextmenu={stopParentContextTriggerGesture}
			onclick={retry}
		>
			<RefreshCw class="size-3.5" aria-hidden="true" />
		</Button>
	{/if}
{/snippet}

<span bind:this={element} class="markdown-image" {title}>
	{#if unavailable}
		<span
			class="markdown-image-error not-prose inline-flex max-w-full items-center gap-2 rounded-md border border-status-error-border bg-status-error px-3 py-2 text-sm text-status-error-foreground"
			role={retryFailed ? 'alert' : undefined}
		>
			<CircleAlert class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="min-w-0 break-words">
				<span class="block">{m.image_unable_to_load()}</span>
				{#if imageName}
					<span class="block text-xs [overflow-wrap:anywhere]">{imageName}</span>
				{/if}
			</span>
			{#if !registerLinkAction}
				{@render retryControl()}
			{/if}
		</span>
	{:else if source}
		{#if externalRetryPending}
			{@render loading()}
		{/if}
		{#key attempt}
			{@const current = attempt}
			{#if canOpen}
				<button
					type="button"
					class="block max-w-full cursor-zoom-in rounded-sm p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={openLabel}
					title={title || openLabel}
					onpointerdowncapture={stopParentContextTriggerGesture}
					oncontextmenu={stopParentContextTriggerGesture}
					onclick={() => {
						if (current === attempt && href) onOpen?.(href);
					}}
				>
					{@render thumbnail(current, source)}
				</button>
			{:else}
				{@render thumbnail(current, source)}
			{/if}
		{/key}
	{:else}
		{@render loading()}
	{/if}
</span>

<style>
	.markdown-image {
		--inline-image-max-width: 640px;
		--inline-image-max-height: 320px;
		display: inline-block;
		max-width: min(100%, var(--inline-image-max-width));
		vertical-align: middle;
	}

	:global(html[data-inline-image-thumbnail-size='small']) .markdown-image {
		--inline-image-max-width: 320px;
		--inline-image-max-height: 180px;
	}

	:global(html[data-inline-image-thumbnail-size='large']) .markdown-image {
		--inline-image-max-width: 960px;
		--inline-image-max-height: 480px;
	}

	:global(html[data-inline-image-thumbnail-size='full']) .markdown-image {
		--inline-image-max-width: 100%;
		--inline-image-max-height: none;
	}

	img {
		display: block;
		width: auto;
		height: auto;
		max-width: 100%;
		max-height: var(--inline-image-max-height);
		object-fit: contain;
		margin: 0;
	}

	.placeholder {
		display: block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
