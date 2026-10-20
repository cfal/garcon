<script lang="ts">
	import { getAbortSignal } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { readContent } from '$lib/api/files.js';
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

	const externalSource = $derived(href && /^(https?:)?\/\//i.test(href) ? href : undefined);
	const file = $derived(href && !externalSource ? resolveImageFile?.(href) : null);
	const executorId = $derived(file?.executorId);
	const executorContextKey = $derived(file?.executorContextKey);
	const projectPath = $derived(file?.projectPath);
	const filePath = $derived(file?.filePath);
	// Scalar dependencies keep equivalent resolver results on the same loading attempt.
	const attempt = $derived({
		externalSource,
		executorId,
		executorContextKey,
		projectPath,
		filePath,
	});
	let element = $state<HTMLSpanElement>();
	// Authored image links retain their destination instead of nesting another control.
	const canOpen = $derived(Boolean(file && onOpen && element && !element.closest('a, button')));
	const openLabel = $derived(m.image_open({ name: text || title || filePath || '' }));
	let loaded = $state.raw<{ attempt: typeof attempt; url: string; release: () => void }>();
	let failed = $state.raw<typeof attempt>();
	const source = $derived(externalSource ?? (loaded?.attempt === attempt ? loaded.url : undefined));
	const unavailable = $derived(
		failed === attempt || (!externalSource && (!executorId || !projectPath || !filePath)),
	);

	$effect(() => {
		const current = attempt;
		const target = element;
		if (!target || !current.executorId || !current.projectPath || !current.filePath) return;
		const params = {
			executorId: current.executorId,
			projectPath: current.projectPath,
			filePath: current.filePath,
		};
		const signal = getAbortSignal();
		let objectUrl: string | undefined;
		let started = false;
		let observer: IntersectionObserver | undefined;

		function release(): void {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			objectUrl = undefined;
		}

		async function load(): Promise<void> {
			if (started || signal.aborted) return;
			started = true;
			observer?.disconnect();
			try {
				const { blob } = await readContent(params, { signal, cache: 'no-store' });
				if (signal.aborted) return;
				if (!blob.type.startsWith('image/')) throw new Error('Invalid image content type');
				objectUrl = URL.createObjectURL(blob);
				loaded = { attempt: current, url: objectUrl, release };
			} catch {
				if (!signal.aborted) failed = current;
			}
		}

		if (typeof IntersectionObserver === 'undefined') {
			void load();
		} else {
			observer = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) void load();
				},
				{ rootMargin: '50px' },
			);
			observer.observe(target);
		}
		return () => {
			observer?.disconnect();
			release();
		};
	});

	function failImage(current: typeof attempt): void {
		if (current !== attempt) return;
		failed = current;
		if (loaded?.attempt === current) loaded.release();
	}

	function stopParentContextTriggerGesture(event: PointerEvent | MouseEvent): void {
		event.stopPropagation();
	}
</script>

{#snippet thumbnail(current: typeof attempt, url: string)}
	<img
		src={url}
		alt={text}
		{title}
		loading="lazy"
		decoding="async"
		referrerpolicy="no-referrer"
		onerror={() => failImage(current)}
	/>
{/snippet}

<span bind:this={element} class="markdown-image" {title}>
	{#if unavailable}
		<span
			class="placeholder text-muted-foreground"
			role="img"
			aria-label={text || m.image_unable_to_load()}
		>
			{m.image_unable_to_load()}
		</span>
	{:else if source}
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
		<span
			class="placeholder text-muted-foreground"
			role="status"
			aria-label={m.image_loading()}
			aria-busy="true"
		>
			<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
		</span>
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
