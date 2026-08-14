import { history, historyKeymap } from '@codemirror/commands';
import {
	Annotation,
	Compartment,
	EditorSelection,
	EditorState,
	Prec,
	Transaction,
} from '@codemirror/state';
import {
	drawSelection,
	dropCursor,
	EditorView,
	highlightSpecialChars,
	keymap,
	type ViewUpdate,
} from '@codemirror/view';
import {
	COMPOSER_EDITOR_KEYMAP,
	COMPOSER_EDITOR_STANDARD_KEYMAP,
	ownsComposerEditorShortcut,
} from './composer-editor-keymap.js';
import {
	clampComposerEditorSelection,
	type ComposerEditorSelection,
} from './composer-editor-selection.js';
import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
import type {
	WorkspaceLocalShortcutOwner,
	WorkspaceShortcutDispatcher,
} from '$lib/workspace/workspace-shortcuts.js';

const externalDocumentSync = Annotation.define<boolean>();

export interface ComposerEditorControllerOptions {
	initialText: string;
	initialSelection: ComposerEditorSelection;
	ariaLabel: string;
	readOnly?: boolean;
	workspaceShortcuts: Pick<WorkspaceShortcutDispatcher, 'registerLocalShortcutOwner'>;
	onTextChange: (text: string) => void;
	onSelectionChange: (selection: ComposerEditorSelection) => void;
}

export class ComposerEditorController {
	readonly #view: EditorView;
	readonly #unregisterLocalOwner: () => void;
	readonly #unregisterScrollRegion: () => void;
	readonly #readOnlyCompartment = new Compartment();
	#selectionNotificationQueued = false;
	#destroyed = false;
	#readOnly: boolean;

	constructor(
		parent: HTMLElement,
		private readonly options: ComposerEditorControllerOptions,
	) {
		this.#readOnly = options.readOnly ?? false;
		const initialSelection = clampComposerEditorSelection(
			options.initialSelection,
			options.initialText.length,
		);
		const editorState = EditorState.create({
			doc: options.initialText,
			selection: EditorSelection.single(initialSelection.anchor, initialSelection.head),
			extensions: [
				this.#readOnlyCompartment.of([
					EditorState.readOnly.of(this.#readOnly),
					EditorView.editable.of(!this.#readOnly),
				]),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				dropCursor(),
				EditorView.lineWrapping,
				Prec.high(keymap.of([...COMPOSER_EDITOR_KEYMAP])),
				keymap.of([...COMPOSER_EDITOR_STANDARD_KEYMAP, ...historyKeymap]),
				EditorView.contentAttributes.of({
					'aria-label': options.ariaLabel,
					'aria-multiline': 'true',
					'aria-readonly': String(this.#readOnly),
				}),
				EditorView.updateListener.of((update) => this.#handleUpdate(update)),
				EditorView.theme({
					'&': {
						height: '100%',
						backgroundColor: 'transparent',
						color: 'hsl(var(--foreground))',
					},
					'&.cm-focused': { outline: 'none' },
					'.cm-scroller': {
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
						fontSize: '16px',
						lineHeight: '1.55',
						overflow: 'auto',
					},
					'.cm-content': {
						caretColor: 'hsl(var(--foreground))',
						minHeight: '100%',
						padding: '16px 18px',
					},
					'.cm-cursor, .cm-dropCursor': {
						borderLeftColor: 'hsl(var(--foreground))',
					},
					'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
						backgroundColor: 'hsl(var(--accent))',
					},
					'@media (pointer: fine)': {
						'.cm-scroller': { fontSize: '14px' },
					},
				}),
			],
		});

		this.#view = new EditorView({ state: editorState, parent });
		const localOwner: WorkspaceLocalShortcutOwner = (event) =>
			ownsComposerEditorShortcut(event, this.#view.composing);
		this.#unregisterLocalOwner = options.workspaceShortcuts.registerLocalShortcutOwner(
			this.#view.dom,
			localOwner,
		);
		this.#unregisterScrollRegion = registerNativeWorkspaceScrollRegion(
			this.#view.scrollDOM,
			'primary',
		);
		this.#emitSelection();
	}

	focus(): void {
		this.#view.focus();
	}

	syncText(text: string, requestedSelection: ComposerEditorSelection = this.selection): void {
		if (text === this.#view.state.doc.toString()) return;
		const selection = clampComposerEditorSelection(requestedSelection, text.length);
		this.#view.dispatch({
			changes: { from: 0, to: this.#view.state.doc.length, insert: text },
			selection: EditorSelection.single(selection.anchor, selection.head),
			annotations: [externalDocumentSync.of(true), Transaction.addToHistory.of(false)],
		});
	}

	setReadOnly(readOnly: boolean): void {
		if (readOnly === this.#readOnly) return;
		this.#readOnly = readOnly;
		this.#view.dispatch({
			effects: this.#readOnlyCompartment.reconfigure([
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
			]),
		});
		this.#view.contentDOM.setAttribute('aria-readonly', String(readOnly));
	}

	get selection(): ComposerEditorSelection {
		const selection = this.#view.state.selection.main;
		return { anchor: selection.anchor, head: selection.head };
	}

	destroy(): void {
		this.#destroyed = true;
		this.#unregisterLocalOwner();
		this.#unregisterScrollRegion();
		this.#view.destroy();
	}

	#handleUpdate(update: ViewUpdate): void {
		const external = update.transactions.some((transaction) =>
			transaction.annotation(externalDocumentSync),
		);
		if (update.docChanged && !external) {
			this.options.onTextChange(update.state.doc.toString());
		}
		if (update.docChanged || update.selectionSet) this.#emitSelection();
	}

	#emitSelection(): void {
		if (this.#selectionNotificationQueued) return;
		this.#selectionNotificationQueued = true;
		queueMicrotask(() => {
			this.#selectionNotificationQueued = false;
			if (!this.#destroyed) this.options.onSelectionChange(this.selection);
		});
	}
}
