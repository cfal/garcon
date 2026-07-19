import {
	normalizePermissionMode,
	normalizeThinkingMode,
	type PermissionMode,
	type ThinkingMode,
} from '$shared/chat-modes';

export function normalizeSupportedPermissionMode(
	value: unknown,
	supported: readonly PermissionMode[],
): PermissionMode {
	const normalized = normalizePermissionMode(value);
	if (supported.includes(normalized)) return normalized;
	return supported[0] ?? 'default';
}

export function normalizeSupportedThinkingMode(
	value: unknown,
	supported: readonly ThinkingMode[],
): ThinkingMode {
	const normalized = normalizeThinkingMode(value);
	if (supported.includes(normalized)) return normalized;
	return supported[0] ?? 'none';
}
