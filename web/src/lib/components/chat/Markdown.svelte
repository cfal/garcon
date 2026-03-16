<!--
@component
Renders markdown content with syntax-highlighted code blocks.
Supports visual variants for assistant, user, and thinking contexts.
-->
<script lang="ts">
	import SvelteMarkdown, { defaultRenderers, buildUnsupportedHTML } from '@humanspeak/svelte-markdown';
	import CodeBlock from './CodeBlock.svelte';
	import MermaidBlock from './MermaidBlock.svelte';
	import { parseFileLink } from '$lib/chat/file-link-parser';

	type MarkdownVariant = 'assistant' | 'user' | 'thinking';

	export interface MarkdownLinkNavigateEvent {
		rawHref: string;
		kind: 'file' | 'ignored';
	}

	interface Props {
		source?: string;
		variant?: MarkdownVariant;
		class?: string;
		/** Base path for accepting absolute file links. */
		projectBasePath?: string;
		/** Called when a link is clicked. Return true to prevent default navigation. */
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
	}

	const VARIANT_STYLES: Record<MarkdownVariant, {
		container: string;
		link: string;
		code: string;
		blockquote: string;
	}> = {
		assistant: {
			container: 'markdown-body prose prose-sm max-w-none min-w-0 max-w-full break-words prose-pre:bg-transparent prose-pre:text-inherit prose-pre:p-3 prose-pre:m-0 prose-pre:rounded-none text-foreground prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground',
			link: 'text-primary hover:underline',
			code: 'rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground',
			blockquote: 'my-2 border-l-4 border-border pl-4 italic text-muted-foreground'
		},
		user: {
			container: 'markdown-body prose prose-sm max-w-none min-w-0 max-w-full break-words prose-pre:bg-transparent prose-pre:text-inherit prose-pre:p-3 prose-pre:m-0 prose-pre:rounded-none text-primary-foreground prose-headings:text-primary-foreground prose-p:text-primary-foreground prose-li:text-primary-foreground prose-strong:text-primary-foreground',
			link: 'text-primary-foreground/90 hover:text-primary-foreground underline',
			code: 'rounded-md border border-primary-foreground/30 bg-primary-foreground/10 px-1.5 py-0.5 font-mono text-[0.9em] text-primary-foreground',
			blockquote: 'my-2 border-l-4 border-primary-foreground/40 pl-4 italic text-primary-foreground/90'
		},
		thinking: {
			container: 'markdown-body prose prose-sm max-w-none min-w-0 max-w-full break-words prose-pre:bg-transparent prose-pre:text-inherit prose-pre:p-3 prose-pre:m-0 prose-pre:rounded-none text-foreground prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground',
			link: 'text-primary hover:underline',
			code: 'rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground',
			blockquote: 'my-2 border-l-4 border-border pl-4 italic text-muted-foreground'
		}
	};

	let {
		source = '',
		variant = 'assistant',
		class: className = '',
		projectBasePath,
		onLinkNavigate
	}: Props = $props();

	const parserOptions = $derived(projectBasePath ? { projectBasePath } : undefined);

	const styles = $derived(VARIANT_STYLES[variant]);
	const containerClass = $derived(`${styles.container} ${className}`.trim());
	const markdownOptions = $derived(variant === 'user' ? { breaks: true } : undefined);

	const safeRenderers = {
		...defaultRenderers,
		html: buildUnsupportedHTML()
	};
</script>

<div class={containerClass}>
	<SvelteMarkdown {source} options={markdownOptions} renderers={safeRenderers}>
		{#snippet code({ lang, text })}
			{#if lang === 'mermaid'}
				<svelte:boundary>
					<MermaidBlock {text} />
					{#snippet failed()}
						<CodeBlock lang="mermaid" {text} />
					{/snippet}
				</svelte:boundary>
			{:else}
				<CodeBlock {lang} {text} />
			{/if}
		{/snippet}

		{#snippet codespan({ raw })}
			<code class={styles.code}>{raw.replace(/`/g, '')}</code>
		{/snippet}

		{#snippet link({ href, title, children })}
			{@const parsed = parseFileLink(href, parserOptions)}
			{@const isFile = parsed.kind === 'file'}
			{@const isAbsPath = !isFile && /^(\/|[A-Za-z]:[/\\])/.test(href ?? '')}
			{@const isExternal = !isFile && !isAbsPath}
			<a
				{href}
				{title}
				class={styles.link}
				target={isExternal ? '_blank' : undefined}
				rel={isExternal ? 'noopener noreferrer' : undefined}
				onclick={(isFile || isAbsPath) ? (e: MouseEvent) => {
					e.preventDefault();
					if (isFile) onLinkNavigate?.({ rawHref: href ?? '', kind: parsed.kind });
				} : undefined}
			>
				{@render children?.()}
			</a>
		{/snippet}

		{#snippet blockquote({ children })}
			<blockquote class={styles.blockquote}>
				{@render children?.()}
			</blockquote>
		{/snippet}

		{#snippet paragraph({ children })}
			<div class="mb-1 last:mb-0 break-words">
				{@render children?.()}
			</div>
		{/snippet}
	</SvelteMarkdown>
</div>
