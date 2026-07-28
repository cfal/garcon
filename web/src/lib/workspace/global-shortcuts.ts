export const GLOBAL_SHORTCUT_IDS = [
	'toggle-command-palette',
	'open-sidebar-search',
	'new-chat',
	'rename-chat',
	'delete-chat',
	'navigate-tab-left',
	'navigate-tab-right',
	'navigate-chat-above',
	'navigate-chat-below',
	'toggle-main-sidebar-focus',
	'open-settings',
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
	defaultBinding: GlobalShortcutBinding;
}

export const GLOBAL_SHORTCUT_DEFINITIONS: readonly GlobalShortcutDefinition[] = [
	{ id: 'toggle-command-palette', defaultBinding: { key: 'p', primary: true } },
	{ id: 'open-sidebar-search', defaultBinding: { key: 's', primary: true } },
	{ id: 'new-chat', defaultBinding: { key: 'n', ctrl: true } },
	{ id: 'rename-chat', defaultBinding: { key: 'r', ctrl: true } },
	{ id: 'delete-chat', defaultBinding: { key: 'd', ctrl: true } },
	{ id: 'navigate-tab-left', defaultBinding: { key: 'j', ctrl: true, shift: true } },
	{ id: 'navigate-tab-right', defaultBinding: { key: 'l', ctrl: true, shift: true } },
	{ id: 'navigate-chat-above', defaultBinding: { key: 'p', ctrl: true, shift: true } },
	{ id: 'navigate-chat-below', defaultBinding: { key: 'n', ctrl: true, shift: true } },
	{
		id: 'toggle-main-sidebar-focus',
		defaultBinding: { key: 'o', ctrl: true, shift: true },
	},
	{ id: 'open-settings', defaultBinding: { key: ',', ctrl: true } },
];

const definitionById = new Map(
	GLOBAL_SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const MODIFIER_KEYS = new Set(['alt', 'altgraph', 'control', 'meta', 'shift']);

function normalizeKey(key: string): string {
	return key === ' ' ? 'space' : key.toLowerCase();
}

function normalizeBinding(value: unknown): GlobalShortcutBinding | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.key !== 'string') return null;
	const key = normalizeKey(candidate.key);
	if (!key || MODIFIER_KEYS.has(key)) return null;

	const binding: GlobalShortcutBinding = { key };
	for (const modifier of ['primary', 'ctrl', 'meta', 'alt', 'shift'] as const) {
		if (candidate[modifier] === true) binding[modifier] = true;
	}
	return binding;
}

export function sanitizeGlobalShortcutOverrides(value: unknown): GlobalShortcutOverrides {
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
	return overrides;
}

export function getEffectiveGlobalShortcut(
	id: GlobalShortcutId,
	overrides: GlobalShortcutOverrides,
): GlobalShortcutBinding | null {
	if (Object.hasOwn(overrides, id)) return overrides[id] ?? null;
	return definitionById.get(id)?.defaultBinding ?? null;
}

export function globalShortcutBindingFromEvent(event: KeyboardEvent): GlobalShortcutBinding | null {
	const key = normalizeKey(event.key);
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
		normalizeKey(event.key) === binding.key &&
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
	unassignedId: GlobalShortcutId | null;
}

export function assignGlobalShortcut(
	current: GlobalShortcutOverrides,
	targetId: GlobalShortcutId,
	binding: GlobalShortcutBinding,
): AssignGlobalShortcutResult {
	const overrides = { ...current };
	let unassignedId: GlobalShortcutId | null = null;

	for (const definition of GLOBAL_SHORTCUT_DEFINITIONS) {
		if (definition.id === targetId) continue;
		const effective = getEffectiveGlobalShortcut(definition.id, overrides);
		if (!effective || !globalShortcutBindingsConflict(effective, binding)) continue;
		overrides[definition.id] = null;
		unassignedId = definition.id;
	}

	const defaultBinding = definitionById.get(targetId)?.defaultBinding;
	if (defaultBinding && bindingsEqual(defaultBinding, binding)) {
		delete overrides[targetId];
	} else {
		overrides[targetId] = binding;
	}
	return { overrides, unassignedId };
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
	const defaultBinding = definitionById.get(id)?.defaultBinding;
	if (!defaultBinding) return { overrides: { ...current }, unassignedId: null };
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
