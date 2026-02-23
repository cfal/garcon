// Typed contracts for the tool display system. Defines the shape
// of display rules that control how each tool's input and result
// are rendered in the chat UI.

export type ToolPayload = Record<string, unknown>;

export type ToolDisplayMode = 'inline' | 'collapsible' | 'hidden';

export type ToolInlineAction = 'copyValue' | 'openFile' | 'jumpToResult' | 'none';

export type ToolContentKind =
	| 'diff'
	| 'markdown'
	| 'fileList'
	| 'todoList'
	| 'text'
	| 'task'
	| 'successMessage';

export interface ToolInputDisplayRule {
	mode: ToolDisplayMode;
	label?: string;
	getValue?: (input: ToolPayload) => string;
	getSecondary?: (input: ToolPayload) => string | undefined;
	action?: ToolInlineAction;
	style?: string;
	wrapText?: boolean;
	colorScheme?: {
		primary?: string;
		secondary?: string;
		background?: string;
		border?: string;
	};
	title?: string | ((input: ToolPayload) => string);
	defaultOpen?: boolean;
	contentKind?: ToolContentKind;
	getContentProps?: (
		input: ToolPayload,
		helpers?: Record<string, unknown>,
	) => Record<string, unknown>;
	actionButton?: 'file-button' | 'none';
}

export interface ToolResultDisplayRule {
	hidden?: boolean;
	hideOnSuccess?: boolean;
	mode?: Extract<ToolDisplayMode, 'inline' | 'collapsible'> | 'special';
	title?: string | ((result: ToolPayload) => string);
	defaultOpen?: boolean;
	contentKind?: ToolContentKind;
	getMessage?: (result: ToolPayload) => string;
	getContentProps?: (result: ToolPayload) => Record<string, unknown>;
}

export interface ToolDisplayRule {
	input: ToolInputDisplayRule;
	result?: ToolResultDisplayRule;
}
