import { PromptEditorController } from '../prompt-editor-controller.js';

const SOURCE = 'Selected prompt text';

export function mountPromptEditor(parent: HTMLElement): PromptEditorController {
	return new PromptEditorController(parent, {
		initialText: SOURCE,
		initialSelection: { anchor: 0, head: SOURCE.length },
		ariaLabel: 'Prompt editor contrast fixture',
		workspaceShortcuts: {
			matchesGlobalShortcut: () => false,
			registerLocalShortcutOwner: () => () => undefined,
		},
		onTextChange: () => undefined,
		onSelectionChange: () => undefined,
	});
}
