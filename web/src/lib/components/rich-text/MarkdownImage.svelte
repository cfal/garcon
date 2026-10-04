<script lang="ts">
	import { getAbortSignal } from 'svelte';
	import { readContent } from '$lib/api/files.js';
	import type { ResolveMarkdownImageFile } from '$lib/chat/file-links/file-link-resolver.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		href,
		title,
		text = '',
		resolveImageFile,
	}: {
		href?: string;
		title?: string;
		text?: string;
		resolveImageFile?: ResolveMarkdownImageFile;
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
</script>

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
			<img
				src={source}
				alt={text}
				{title}
				loading="lazy"
				decoding="async"
				referrerpolicy="no-referrer"
				onerror={() => failImage(current)}
			/>
		{/key}
	{:else}
		<span class="placeholder text-muted-foreground" aria-busy="true">{m.image_loading()}</span>
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
