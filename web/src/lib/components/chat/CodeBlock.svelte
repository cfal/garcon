<!--
@component
Renders a fenced code block with syntax highlighting via highlight.js.
Highlight.js core and language packs load on demand so the initial bundle
does not ship ~100KB of syntax definitions for pages that render no code.
-->
<script module lang="ts">
	import type { HLJSApi, LanguageFn } from 'highlight.js';

	const commonAliases: Record<string, string> = {
		js: 'javascript',
		ts: 'typescript',
		py: 'python',
		sh: 'bash',
		html: 'xml',
		md: 'markdown',
		yml: 'yaml',
		rs: 'rust',
		cs: 'csharp',
		rb: 'ruby',
		kt: 'kotlin',
		text: 'plaintext',
	};

	const languageLoaders: Record<string, () => Promise<{ default: LanguageFn }>> = {
		javascript: () => import('highlight.js/lib/languages/javascript'),
		typescript: () => import('highlight.js/lib/languages/typescript'),
		python: () => import('highlight.js/lib/languages/python'),
		bash: () => import('highlight.js/lib/languages/bash'),
		json: () => import('highlight.js/lib/languages/json'),
		css: () => import('highlight.js/lib/languages/css'),
		xml: () => import('highlight.js/lib/languages/xml'),
		markdown: () => import('highlight.js/lib/languages/markdown'),
		yaml: () => import('highlight.js/lib/languages/yaml'),
		sql: () => import('highlight.js/lib/languages/sql'),
		rust: () => import('highlight.js/lib/languages/rust'),
		go: () => import('highlight.js/lib/languages/go'),
		java: () => import('highlight.js/lib/languages/java'),
		c: () => import('highlight.js/lib/languages/c'),
		cpp: () => import('highlight.js/lib/languages/cpp'),
		csharp: () => import('highlight.js/lib/languages/csharp'),
		ruby: () => import('highlight.js/lib/languages/ruby'),
		php: () => import('highlight.js/lib/languages/php'),
		swift: () => import('highlight.js/lib/languages/swift'),
		kotlin: () => import('highlight.js/lib/languages/kotlin'),
		diff: () => import('highlight.js/lib/languages/diff'),
		shell: () => import('highlight.js/lib/languages/shell'),
		plaintext: () => import('highlight.js/lib/languages/plaintext'),
	};

	let hljsPromise: Promise<HLJSApi> | null = null;
	const loadedLanguages = new Set<string>();

	function canonicalLangName(raw: string): string {
		const key = raw.toLowerCase();
		return commonAliases[key] ?? key;
	}

	async function loadHljs(): Promise<HLJSApi> {
		if (!hljsPromise) {
			hljsPromise = import('highlight.js/lib/core').then((m) => m.default);
		}
		return hljsPromise;
	}

	async function ensureLanguage(hljs: HLJSApi, name: string): Promise<boolean> {
		if (loadedLanguages.has(name)) return true;
		const loader = languageLoaders[name];
		if (!loader) return false;
		try {
			const mod = await loader();
			hljs.registerLanguage(name, mod.default);
			loadedLanguages.add(name);
			return true;
		} catch {
			return false;
		}
	}

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
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

	const escapedText = $derived(text ? escapeHtml(text) : '');
	let asyncHighlighted = $state<string | null>(null);
	const highlighted = $derived(asyncHighlighted ?? escapedText);
	let highlightToken = 0;

	// Highlights text asynchronously so highlight.js and its language
	// definitions only load when a code block actually renders. While
	// loading, keeps the escaped plain text visible so SSR and first paint
	// never render an empty block.
	$effect(() => {
		const currentText = text;
		const currentLang = lang;
		const token = ++highlightToken;

		if (!currentText) {
			asyncHighlighted = null;
			return;
		}

		asyncHighlighted = null;

		void (async () => {
			const hljs = await loadHljs();
			if (token !== highlightToken) return;

			const normalized = currentLang ? canonicalLangName(currentLang) : '';
			let result: string;
			if (normalized && (await ensureLanguage(hljs, normalized)) && hljs.getLanguage(normalized)) {
				result = hljs.highlight(currentText, { language: normalized }).value;
			} else {
				// Plaintext fallback avoids highlightAuto's multi-language probing cost.
				await ensureLanguage(hljs, 'plaintext');
				result = hljs.getLanguage('plaintext')
					? hljs.highlight(currentText, { language: 'plaintext' }).value
					: escapeHtml(currentText);
			}

			if (token === highlightToken) {
				asyncHighlighted = result;
			}
		})();
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
