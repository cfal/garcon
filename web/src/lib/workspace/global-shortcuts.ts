export const GLOBAL_SHORTCUT_IDS = [
	'toggle-command-palette',
	'open-sidebar-search',
	'new-chat',
	'open-composer-editor',
	'rename-chat',
	'delete-chat',
	'navigate-tab-left',
	'navigate-tab-right',
	'navigate-chat-above',
	'navigate-chat-below',
	'cycle-window-focus',
	'open-settings',
	'scroll-half-page-up',
	'scroll-half-page-down',
	'file-save',
	'editor-find',
	'editor-replace',
	'editor-go-to-line',
	'editor-go-to-matching-bracket',
	'editor-indent',
	'editor-outdent',
	'editor-toggle-comment',
	'editor-duplicate-line-up',
	'editor-duplicate-line-down',
	'editor-move-line-up',
	'editor-move-line-down',
	'editor-delete-line',
	'file-navigate-back',
	'file-navigate-forward',
] as const;

export type GlobalShortcutId = (typeof GLOBAL_SHORTCUT_IDS)[number];

export interface GlobalShortcutBinding {
	key: string;
	primary?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	alt?: boolean;
	shift?: boolean;
}

export type GlobalShortcutOverrides = Partial<
	Record<GlobalShortcutId, GlobalShortcutBinding | null>
>;

export interface GlobalShortcutDefinition {
	id: GlobalShortcutId;
	context: 'workspace' | 'chat' | 'file';
	defaultBinding: GlobalShortcutBinding;
}

export const GLOBAL_SHORTCUT_DEFINITIONS: readonly GlobalShortcutDefinition[] = [
	{
		id: 'toggle-command-palette',
		context: 'workspace',
		defaultBinding: { key: 'p', primary: true },
	},
	{ id: 'open-sidebar-search', context: 'chat', defaultBinding: { key: 's', primary: true } },
	{ id: 'new-chat', context: 'workspace', defaultBinding: { key: 'n', ctrl: true } },
	{
		id: 'open-composer-editor',
		context: 'chat',
		defaultBinding: { key: 'e', ctrl: true, shift: true },
	},
	{ id: 'rename-chat', context: 'chat', defaultBinding: { key: 'r', ctrl: true } },
	{ id: 'delete-chat', context: 'chat', defaultBinding: { key: 'd', ctrl: true, shift: true } },
	{
		id: 'navigate-tab-left',
		context: 'workspace',
		defaultBinding: { key: 'j', ctrl: true, shift: true },
	},
	{
		id: 'navigate-tab-right',
		context: 'workspace',
		defaultBinding: { key: 'l', ctrl: true, shift: true },
	},
	{
		id: 'navigate-chat-above',
		context: 'chat',
		defaultBinding: { key: 'p', ctrl: true, shift: true },
	},
	{
		id: 'navigate-chat-below',
		context: 'chat',
		defaultBinding: { key: 'n', ctrl: true, shift: true },
	},
	{
		id: 'cycle-window-focus',
		context: 'workspace',
		defaultBinding: { key: 'o', ctrl: true, shift: true },
	},
	{ id: 'open-settings', context: 'workspace', defaultBinding: { key: ',', ctrl: true } },
	{ id: 'scroll-half-page-up', context: 'workspace', defaultBinding: { key: 'u', ctrl: true } },
	{ id: 'scroll-half-page-down', context: 'workspace', defaultBinding: { key: 'd', ctrl: true } },
	{ id: 'file-save', context: 'file', defaultBinding: { key: 's', primary: true } },
	{ id: 'editor-find', context: 'file', defaultBinding: { key: 'f', primary: true } },
	{ id: 'editor-replace', context: 'file', defaultBinding: { key: 'f', primary: true, alt: true } },
	{
		id: 'editor-go-to-line',
		context: 'file',
		defaultBinding: { key: 'g', primary: true, alt: true },
	},
	{
		id: 'editor-go-to-matching-bracket',
		context: 'file',
		defaultBinding: { key: '\\', primary: true, shift: true },
	},
	{ id: 'editor-indent', context: 'file', defaultBinding: { key: ']', primary: true } },
	{ id: 'editor-outdent', context: 'file', defaultBinding: { key: '[', primary: true } },
	{ id: 'editor-toggle-comment', context: 'file', defaultBinding: { key: '/', primary: true } },
	{
		id: 'editor-duplicate-line-up',
		context: 'file',
		defaultBinding: { key: 'arrowup', alt: true, shift: true },
	},
	{
		id: 'editor-duplicate-line-down',
		context: 'file',
		defaultBinding: { key: 'arrowdown', alt: true, shift: true },
	},
	{ id: 'editor-move-line-up', context: 'file', defaultBinding: { key: 'arrowup', alt: true } },
	{ id: 'editor-move-line-down', context: 'file', defaultBinding: { key: 'arrowdown', alt: true } },
	{
		id: 'editor-delete-line',
		context: 'file',
		defaultBinding: { key: 'k', primary: true, shift: true },
	},
	{ id: 'file-navigate-back', context: 'file', defaultBinding: { key: 'arrowleft', alt: true } },
	{
		id: 'file-navigate-forward',
		context: 'file',
		defaultBinding: { key: 'arrowright', alt: true },
	},
];

const definitionById = new Map(
	GLOBAL_SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const MODIFIER_KEYS = new Set(['alt', 'altgraph', 'control', 'meta', 'shift']);
const SHIFTED_PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
	Backquote: '`',
	Backslash: '\\',
	BracketLeft: '[',
	BracketRight: ']',
	Comma: ',',
	Digit0: '0',
	Digit1: '1',
	Digit2: '2',
	Digit3: '3',
	Digit4: '4',
	Digit5: '5',
	Digit6: '6',
	Digit7: '7',
	Digit8: '8',
	Digit9: '9',
	Equal: '=',
	Minus: '-',
	Period: '.',
	Quote: "'",
	Semicolon: ';',
	Slash: '/',
};
const UNSHIFTED_PUNCTUATION: Readonly<Record<string, string>> = {
	'~': '`',
	'!': '1',
	'@': '2',
	'#': '3',
	$: '4',
	'%': '5',
	'^': '6',
	'&': '7',
	'*': '8',
	'(': '9',
	')': '0',
	_: '-',
	'+': '=',
	'{': '[',
	'}': ']',
	'|': '\\',
	':': ';',
	'"': "'",
	'<': ',',
	'>': '.',
	'?': '/',
};

function normalizeKey(key: string): string {
	return key === ' ' ? 'space' : key.toLowerCase();
}

function normalizeEventKey(event: KeyboardEvent): string {
	if (event.shiftKey && SHIFTED_PUNCTUATION_BY_CODE[event.code]) {
		return SHIFTED_PUNCTUATION_BY_CODE[event.code];
	}
	return normalizeKey(event.key);
}

function isMacKeyboard(): boolean {
	return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

function normalizeBinding(value: unknown): GlobalShortcutBinding | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.key !== 'string') return null;
	const normalizedKey = normalizeKey(candidate.key);
	const key =
		candidate.shift === true
			? (UNSHIFTED_PUNCTUATION[normalizedKey] ?? normalizedKey)
			: normalizedKey;
	if (!key || MODIFIER_KEYS.has(key)) return null;

	const binding: GlobalShortcutBinding = { key };
	for (const modifier of ['primary', 'ctrl', 'meta', 'alt', 'shift'] as const) {
		if (candidate[modifier] === true) binding[modifier] = true;
	}
	return binding;
}

export function sanitizeGlobalShortcutOverrides(
	value: unknown,
	isMac = isMacKeyboard(),
): GlobalShortcutOverrides {
	if (!value || typeof value !== 'object') return {};
	const candidate = value as Record<string, unknown>;
	const overrides: GlobalShortcutOverrides = {};

	for (const id of GLOBAL_SHORTCUT_IDS) {
		if (!Object.hasOwn(candidate, id)) continue;
		if (candidate[id] === null) {
			overrides[id] = null;
			continue;
		}
		const binding = normalizeBinding(candidate[id]);
		if (binding && isSafeGlobalShortcutBinding(binding)) overrides[id] = binding;
	}

	// Preserves persisted custom bindings when a later release adds or moves a default.
	for (const definition of GLOBAL_SHORTCUT_DEFINITIONS) {
		if (Object.hasOwn(overrides, definition.id)) continue;
		const defaultBinding = getDefaultGlobalShortcut(definition.id, isMac);
		if (!defaultBinding) continue;
		const conflictsWithOverride = GLOBAL_SHORTCUT_IDS.some((id) => {
			const binding = overrides[id];
			return binding && globalShortcutContextsOverlap(definition.id, id)
				? globalShortcutBindingsConflict(defaultBinding, binding)
				: false;
		});
		if (conflictsWithOverride) overrides[definition.id] = null;
	}
	return overrides;
}

export function getDefaultGlobalShortcut(
	id: GlobalShortcutId,
	isMac = isMacKeyboard(),
): GlobalShortcutBinding | null {
	if (isMac && id === 'file-navigate-back') return { key: '-', ctrl: true };
	if (isMac && id === 'file-navigate-forward') return { key: '-', ctrl: true, shift: true };
	return definitionById.get(id)?.defaultBinding ?? null;
}

export function getEffectiveGlobalShortcut(
	id: GlobalShortcutId,
	overrides: GlobalShortcutOverrides,
): GlobalShortcutBinding | null {
	if (Object.hasOwn(overrides, id)) return overrides[id] ?? null;
	return getDefaultGlobalShortcut(id);
}

export function globalShortcutBindingFromEvent(event: KeyboardEvent): GlobalShortcutBinding | null {
	const key = normalizeEventKey(event);
	if (!key || MODIFIER_KEYS.has(key)) return null;

	const binding: GlobalShortcutBinding = { key };
	if (event.ctrlKey) binding.ctrl = true;
	if (event.metaKey) binding.meta = true;
	if (event.altKey) binding.alt = true;
	if (event.shiftKey) binding.shift = true;
	return binding;
}

export function isSafeGlobalShortcutBinding(binding: GlobalShortcutBinding): boolean {
	return Boolean(
		binding.ctrl ||
		binding.meta ||
		binding.alt ||
		binding.primary ||
		/^f(?:[1-9]|1[0-2])$/.test(binding.key),
	);
}

export function globalShortcutMatchesEvent(
	binding: GlobalShortcutBinding,
	event: KeyboardEvent,
): boolean {
	const primaryMatches = binding.primary
		? event.ctrlKey !== event.metaKey
		: event.ctrlKey === Boolean(binding.ctrl) && event.metaKey === Boolean(binding.meta);
	return (
		normalizeEventKey(event) === binding.key &&
		primaryMatches &&
		event.altKey === Boolean(binding.alt) &&
		event.shiftKey === Boolean(binding.shift)
	);
}

function modifierSignatures(binding: GlobalShortcutBinding): string[] {
	const ctrlMeta = binding.primary
		? [
				{ ctrl: true, meta: false },
				{ ctrl: false, meta: true },
			]
		: [{ ctrl: Boolean(binding.ctrl), meta: Boolean(binding.meta) }];
	return ctrlMeta.map(
		({ ctrl, meta }) =>
			`${binding.key}:${ctrl}:${meta}:${Boolean(binding.alt)}:${Boolean(binding.shift)}`,
	);
}

export function globalShortcutBindingsConflict(
	first: GlobalShortcutBinding,
	second: GlobalShortcutBinding,
): boolean {
	const secondSignatures = new Set(modifierSignatures(second));
	return modifierSignatures(first).some((signature) => secondSignatures.has(signature));
}

export function globalShortcutContextsOverlap(
	first: GlobalShortcutId,
	second: GlobalShortcutId,
): boolean {
	const firstContext = definitionById.get(first)!.context;
	const secondContext = definitionById.get(second)!.context;
	return (
		firstContext === 'workspace' || secondContext === 'workspace' || firstContext === secondContext
	);
}

function bindingsEqual(first: GlobalShortcutBinding, second: GlobalShortcutBinding): boolean {
	return (
		first.key === second.key &&
		Boolean(first.primary) === Boolean(second.primary) &&
		Boolean(first.ctrl) === Boolean(second.ctrl) &&
		Boolean(first.meta) === Boolean(second.meta) &&
		Boolean(first.alt) === Boolean(second.alt) &&
		Boolean(first.shift) === Boolean(second.shift)
	);
}

export interface AssignGlobalShortcutResult {
	overrides: GlobalShortcutOverrides;
	unassignedIds: GlobalShortcutId[];
}

export function assignGlobalShortcut(
	current: GlobalShortcutOverrides,
	targetId: GlobalShortcutId,
	binding: GlobalShortcutBinding,
): AssignGlobalShortcutResult {
	const overrides = { ...current };
	const unassignedIds: GlobalShortcutId[] = [];

	for (const definition of GLOBAL_SHORTCUT_DEFINITIONS) {
		if (definition.id === targetId || !globalShortcutContextsOverlap(definition.id, targetId))
			continue;
		const effective = getEffectiveGlobalShortcut(definition.id, overrides);
		if (!effective || !globalShortcutBindingsConflict(effective, binding)) continue;
		overrides[definition.id] = null;
		unassignedIds.push(definition.id);
	}

	const defaultBinding = getDefaultGlobalShortcut(targetId);
	if (defaultBinding && bindingsEqual(defaultBinding, binding)) {
		delete overrides[targetId];
	} else {
		overrides[targetId] = binding;
	}
	return { overrides, unassignedIds };
}

export function disableGlobalShortcut(
	current: GlobalShortcutOverrides,
	id: GlobalShortcutId,
): GlobalShortcutOverrides {
	return { ...current, [id]: null };
}

export function resetGlobalShortcut(
	current: GlobalShortcutOverrides,
	id: GlobalShortcutId,
): AssignGlobalShortcutResult {
	const defaultBinding = getDefaultGlobalShortcut(id);
	if (!defaultBinding) return { overrides: { ...current }, unassignedIds: [] };
	return assignGlobalShortcut(current, id, defaultBinding);
}

export function formatGlobalShortcut(binding: GlobalShortcutBinding, isMac = false): string[] {
	const parts: string[] = [];
	if (binding.primary) parts.push(isMac ? 'Cmd' : 'Ctrl');
	if (binding.ctrl) parts.push('Ctrl');
	if (binding.meta) parts.push(isMac ? 'Cmd' : 'Meta');
	if (binding.alt) parts.push(isMac ? 'Option' : 'Alt');
	if (binding.shift) parts.push('Shift');

	const labels: Record<string, string> = {
		arrowdown: 'Arrow Down',
		arrowleft: 'Arrow Left',
		arrowright: 'Arrow Right',
		arrowup: 'Arrow Up',
		space: 'Space',
	};
	parts.push(
		labels[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key),
	);
	return parts;
}
