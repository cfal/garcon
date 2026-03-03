<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { EditorView, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, highlightActiveLine, keymap } from '@codemirror/view';
	import { EditorState, Compartment, type Extension } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language';
	import { oneDark } from '@codemirror/theme-one-dark';
	import { unifiedMergeView } from '@codemirror/merge';
	import { loadLanguageExtension } from './language-loader';
	import { Save, X, Maximize2, Minimize2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import EditorSettingsMenu from './EditorSettingsMenu.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface CodeEditorProps {
		content: string;
		filePath: string;
		language?: string;
		readOnly?: boolean;
		onChange?: (value: string) => void;
		onDirtyChange?: (dirty: boolean) => void;
		onSave?: (value: string) => Promise<void> | void;
		onClose?: () => void;
		onToggleExpand?: (() => void) | null;
		isSidebar?: boolean;
		isExpanded?: boolean;
		wordWrap?: boolean;
		showLineNumbers?: boolean;
		fontSize?: number;
		oldContent?: string | null;
		showDiff?: boolean;
		initialLine?: number;
		initialColumn?: number;
		showMarkdownViewButton?: boolean;
		onRequestMarkdownView?: () => void;
	}

	let {
		content,
		filePath,
		language = '',
		readOnly = false,
		onChange,
		onDirtyChange,
		onSave,
		onClose,
		onToggleExpand = null,
		isSidebar = false,
		isExpanded = false,
		wordWrap = false,
		showLineNumbers: showLineNums = true,
		fontSize = 14,
		oldContent = null,
		showDiff = false,
		initialLine,
		initialColumn,
		showMarkdownViewButton = false,
		onRequestMarkdownView,
	}: CodeEditorProps = $props();

	let editorContainer: HTMLDivElement | undefined = $state();
	let editorView: EditorView | undefined = $state();
	let isFullscreen = $state(false);
	let saving = $state(false);
	let saveSuccess = $state(false);
	let currentContent = $state('');
	let baselineContent = $state('');

	// Tracks the effective dark/light mode from the root element class.
	let isDark = $state(document.documentElement.classList.contains('dark'));

	// Derives the file name from the path for display.
	let fileName = $derived(filePath.split('/').pop() ?? filePath);

	// Derives the current line count from content.
	let lineCount = $derived(currentContent.split('\n').length);

	const dynamicCompartment = new Compartment();
	const languageCompartment = new Compartment();

	/** Builds static extensions that never change after mount. */
	function buildStaticExtensions(): Extension[] {
		return [
			highlightActiveLineGutter(),
			highlightSpecialChars(),
			history(),
			drawSelection(),
			dropCursor(),
			indentOnInput(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			bracketMatching(),
			highlightActiveLine(),
			keymap.of([
				...defaultKeymap,
				...historyKeymap,
				...foldKeymap,
				indentWithTab,
			]),
			foldGutter(),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					currentContent = update.state.doc.toString();
					onChange?.(currentContent);
					onDirtyChange?.(currentContent !== baselineContent);
				}
			}),
		];
	}

	/** Builds dynamic extensions that depend on reactive props. */
	function buildDynamicExtensions(): Extension[] {
		const extensions: Extension[] = [
			EditorView.theme({
				'&': { fontSize: `${fontSize}px` },
				'.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
				'.cm-gutters': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
			}),
		];

		if (isDark) extensions.push(oneDark);

		if (showLineNums) extensions.push(lineNumbers());
		if (wordWrap) extensions.push(EditorView.lineWrapping);
		if (readOnly) extensions.push(EditorState.readOnly.of(true));

		if (showDiff && oldContent != null) {
			extensions.push(
				unifiedMergeView({
					original: oldContent,
					gutter: true,
					highlightChanges: true,
				})
			);
		}

		return extensions;
	}

	onMount(() => {
		if (!editorContainer) return;
		currentContent = content;
		baselineContent = content;
		onDirtyChange?.(false);

		const editorState = EditorState.create({
			doc: content,
			extensions: [
				...buildStaticExtensions(),
				languageCompartment.of([]),
				dynamicCompartment.of(buildDynamicExtensions()),
			],
		});

		editorView = new EditorView({
			state: editorState,
			parent: editorContainer,
		});

		// Load language pack asynchronously after mount.
		void applyLanguage(filePath);
	});

	/** Lazily loads and applies the language extension for the given file. */
	async function applyLanguage(path: string): Promise<void> {
		const exts = await loadLanguageExtension(path);
		editorView?.dispatch({
			effects: languageCompartment.reconfigure(exts),
		});
	}

	onDestroy(() => {
		editorView?.destroy();
	});

	/** Moves the selection and viewport to the requested line/column. */
	function jumpToLine(lineNumber: number, columnNumber?: number): void {
		if (!editorView) return;
		const line = Math.max(1, Math.min(lineNumber, editorView.state.doc.lines));
		const lineInfo = editorView.state.doc.line(line);
		const colOffset = Math.max(0, (columnNumber ?? 1) - 1);
		const pos = Math.min(lineInfo.from + colOffset, lineInfo.to);
		editorView.dispatch({
			selection: { anchor: pos },
			effects: EditorView.scrollIntoView(pos, { y: 'start' }),
		});
		editorView.focus();
	}

	// Observes dark class on <html> to keep the editor theme in sync.
	$effect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			isDark = root.classList.contains('dark');
		});
		observer.observe(root, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	});

	// Reconfigures dynamic extensions when props or theme change.
	$effect(() => {
		if (!editorView) return;
		const _ww = wordWrap;
		const _ln = showLineNums;
		const _fs = fontSize;
		const _ro = readOnly;
		const _sd = showDiff;
		const _oc = oldContent;
		const _dk = isDark;

		editorView.dispatch({
			effects: dynamicCompartment.reconfigure(buildDynamicExtensions()),
		});
	});

	// Reloads language extension when the file path changes.
	$effect(() => {
		if (!editorView) return;
		void applyLanguage(filePath);
	});

	// Replaces the editor document when content changes from outside.
	$effect(() => {
		if (!editorView) return;
		const doc = editorView.state.doc.toString();
		if (content !== doc) {
			editorView.dispatch({
				changes: {
					from: 0,
					to: editorView.state.doc.length,
					insert: content,
				},
			});
			currentContent = content;
			baselineContent = content;
			onDirtyChange?.(false);
		}
	});

	// Jumps to requested line/column for open-from-location flows.
	$effect(() => {
		if (!editorView) return;
		const line = initialLine;
		const col = initialColumn;
		const _path = filePath;
		if (!line || line < 1) return;
		jumpToLine(line, col);
	});

	async function handleSave() {
		if (!onSave) return;
		saving = true;
		try {
			await onSave(currentContent);
			baselineContent = currentContent;
			onDirtyChange?.(false);
			saveSuccess = true;
			setTimeout(() => (saveSuccess = false), 2000);
		} catch (err) {
			console.error('[CodeEditor] Save failed:', err);
			saveSuccess = false;
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			void handleSave();
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose?.();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class={isSidebar
		? 'w-full h-full flex flex-col'
		: `fixed inset-0 z-40 md:bg-black/50 md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`}
>
	<div
		class={isSidebar
			? 'bg-background flex flex-col w-full h-full'
			: `bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl ${
				isFullscreen ? 'md:w-full md:h-full md:rounded-none' : 'md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
			}`}
	>
		<!-- Header -->
		<div class="flex items-center justify-between p-4 border-b border-border flex-shrink-0 min-w-0">
			<div class="flex items-center gap-3 min-w-0 flex-1">
				<div class="min-w-0 flex-1">
					<h3 class="font-medium text-foreground truncate">{fileName}</h3>
					<p class="text-sm text-muted-foreground truncate">{filePath}</p>
				</div>
			</div>

			<div class="flex items-center gap-1 md:gap-2 flex-shrink-0">
				{#if showMarkdownViewButton && onRequestMarkdownView}
					<Button
						variant="ghost"
						size="sm"
						onclick={onRequestMarkdownView}
						title="Switch to markdown view"
					>
						View
					</Button>
				{/if}
				{#if onSave}
					<Button
						variant={saveSuccess ? 'default' : 'default'}
						size="sm"
						onclick={handleSave}
						disabled={saving}
						class={saveSuccess
							? 'bg-status-success hover:bg-status-success/90 text-status-success-foreground'
							: 'bg-primary hover:bg-primary/90 text-primary-foreground'}
					>
						<Save class="w-4 h-4" />
						<span class="hidden sm:inline">{saving ? m.editor_actions_saving() : saveSuccess ? m.editor_actions_saved() : m.editor_actions_save()}</span>
					</Button>
				{/if}

				{#if !isSidebar}
					<Button
						variant="ghost"
						size="icon-sm"
						class="hidden md:flex"
						onclick={() => (isFullscreen = !isFullscreen)}
						title={isFullscreen ? m.editor_actions_exit_fullscreen() : m.editor_actions_fullscreen()}
					>
						{#if isFullscreen}
							<Minimize2 class="w-4 h-4" />
						{:else}
							<Maximize2 class="w-4 h-4" />
						{/if}
					</Button>
				{/if}

				{#if isSidebar && onToggleExpand}
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={onToggleExpand}
						title={isExpanded ? m.editor_actions_collapse() : m.editor_actions_expand()}
					>
						{#if isExpanded}
							<Minimize2 class="w-4 h-4" />
						{:else}
							<Maximize2 class="w-4 h-4" />
						{/if}
					</Button>
				{/if}

				<EditorSettingsMenu />

				{#if onClose}
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={onClose}
						title={m.editor_actions_close()}
					>
						<X class="w-4 h-4" />
					</Button>
				{/if}
			</div>
		</div>

		<!-- Editor container -->
		<div class="flex-1 overflow-hidden">
			<div bind:this={editorContainer} class="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"></div>
		</div>

		<!-- Footer -->
		<div class="flex items-center justify-between p-3 border-t border-border bg-muted flex-shrink-0">
			<div class="flex items-center gap-4 text-sm text-muted-foreground">
				<span>{m.editor_footer_lines()} {lineCount}</span>
			</div>
			<div class="text-sm text-muted-foreground">
				{m.editor_footer_ctrl_s_to_save()}
			</div>
		</div>
	</div>
</div>
