<!--
@component
Renders a fenced code block with syntax highlighting via highlight.js.
Registers languages once at module scope for efficiency.
-->
<script module lang="ts">
	import hljs from 'highlight.js/lib/core';
	import type { LanguageFn } from 'highlight.js';
	import javascript from 'highlight.js/lib/languages/javascript';
	import typescript from 'highlight.js/lib/languages/typescript';
	import python from 'highlight.js/lib/languages/python';
	import bash from 'highlight.js/lib/languages/bash';
	import json from 'highlight.js/lib/languages/json';
	import css from 'highlight.js/lib/languages/css';
	import xml from 'highlight.js/lib/languages/xml';
	import markdown from 'highlight.js/lib/languages/markdown';
	import yaml from 'highlight.js/lib/languages/yaml';
	import sql from 'highlight.js/lib/languages/sql';
	import rust from 'highlight.js/lib/languages/rust';
	import go from 'highlight.js/lib/languages/go';
	import java from 'highlight.js/lib/languages/java';
	import c from 'highlight.js/lib/languages/c';
	import cpp from 'highlight.js/lib/languages/cpp';
	import csharp from 'highlight.js/lib/languages/csharp';
	import ruby from 'highlight.js/lib/languages/ruby';
	import php from 'highlight.js/lib/languages/php';
	import swift from 'highlight.js/lib/languages/swift';
	import kotlin from 'highlight.js/lib/languages/kotlin';
	import diff from 'highlight.js/lib/languages/diff';
	import shell from 'highlight.js/lib/languages/shell';
	import plaintext from 'highlight.js/lib/languages/plaintext';

	const languageMap: Record<string, LanguageFn> = {
		javascript,
		js: javascript,
		typescript,
		ts: typescript,
		python,
		py: python,
		bash,
		sh: bash,
		json,
		css,
		html: xml,
		xml,
		markdown,
		md: markdown,
		yaml,
		yml: yaml,
		sql,
		rust,
		rs: rust,
		go,
		java,
		c,
		cpp,
		csharp,
		cs: csharp,
		ruby,
		rb: ruby,
		php,
		swift,
		kotlin,
		kt: kotlin,
		diff,
		shell,
		plaintext,
		text: plaintext
	};

	for (const [name, lang] of Object.entries(languageMap)) {
		hljs.registerLanguage(name, lang);
	}
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		lang?: string;
		text?: string;
	}

	let { lang = '', text = '' }: Props = $props();

	const highlighted = $derived.by(() => {
		if (!text) return '';
		if (lang && hljs.getLanguage(lang)) {
			return hljs.highlight(text, { language: lang }).value;
		}
		return hljs.highlightAuto(text).value;
	});

	let copied = $state(false);
	async function handleCopy() {
		const didCopy = await copyToClipboard(text);
		if (!didCopy) return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="group relative overflow-hidden rounded-md border border-border bg-muted/30">
	<div
		class="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
	>
		<span>{lang || 'text'}</span>
		<button
			onclick={handleCopy}
			class="inline-flex h-6 w-6 items-center justify-center rounded opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 hover:bg-accent"
			title={m.chat_code_block_copy()}
			aria-label={copied ? m.chat_code_block_copied() : m.chat_code_block_copy()}
		>
			{#if copied}
				<svg
					class="w-3 h-3 text-status-success-foreground"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
			{:else}
				<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
					/>
				</svg>
			{/if}
		</button>
	</div>
	<pre class="overflow-x-auto p-3 text-sm leading-relaxed"><code class="hljs">{@html highlighted}</code></pre>
</div>
