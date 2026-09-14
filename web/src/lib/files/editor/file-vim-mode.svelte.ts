import { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import './file-vim-mode.css';

type VimModule = typeof import('@replit/codemirror-vim');
const VIM_CONTROL_KEYS = new Set(['b', 'd', 'e', 'r', 'u', 'y', 'o', 'i', 'w', 'v', 'c', '[', ']']);
let modulePromise: Promise<VimModule> | null = null;

function loadVim(): Promise<VimModule> {
	return (modulePromise ??= import('@replit/codemirror-vim'));
}

export class FileVimMode {
	readonly compartment = new Compartment();
	error = $state<string | null>(null);
	#module: VimModule | null = null;
	#generation = 0;

	constructor(
		private readonly host: {
			getView(): EditorView | null;
			undo(): boolean;
			redo(): boolean;
			save(): void;
		},
	) {}

	configure(enabled: boolean): void {
		const generation = ++this.#generation;
		const view = this.host.getView();
		if (!view) return;
		if (!enabled) {
			this.error = null;
			if (this.#module?.getCM(view)) view.dispatch({ effects: this.compartment.reconfigure([]) });
			return;
		}
		if (this.error || this.#module?.getCM(view)) return;
		void loadVim()
			.then((module) => {
				if (generation !== this.#generation || view !== this.host.getView()) return;
				this.#module = module;
				view.dispatch({
					effects: this.compartment.reconfigure(
						module.vim({
							status: true,
							undo: () => this.host.undo(),
							redo: () => this.host.redo(),
							save: () => this.host.save(),
						}),
					),
				});
			})
			.catch((error: unknown) => {
				if (generation === this.#generation && view === this.host.getView()) {
					this.error = `Vim mode could not load: ${error instanceof Error ? error.message : String(error)}`;
				}
			});
	}

	ownsKey(event: KeyboardEvent): boolean {
		const view = this.host.getView();
		if (!view) return false;
		const adapter = this.#module?.getCM(view);
		if (!adapter || !(event.target instanceof HTMLElement)) return false;
		if (!view.contentDOM.contains(event.target) && !event.target.closest('.cm-vim-panel'))
			return false;
		if (event.key === 'Escape') return true;
		if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;

		// These Vim control keys must reach its plugin before Workspace shortcuts.
		const key = event.key.toLowerCase();
		if (key === 'n') return !adapter.state.vim?.insertMode;
		return VIM_CONTROL_KEYS.has(key);
	}

	dismissDialog(): void {
		const input = this.host.getView()?.dom.querySelector<HTMLInputElement>('.cm-vim-panel input');
		input?.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Escape',
				keyCode: 27,
				bubbles: true,
				cancelable: true,
			}),
		);
	}
}
