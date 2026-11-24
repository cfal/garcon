export interface SidebarCollapseChoices {
	collapsedProjectKeys?: ReadonlySet<string>;
	expandedDelegationKeys?: ReadonlySet<string>;
}

export const DELEGATION_KEY_PREFIX = 'delegation:';

export function isSidebarKeyCollapsed(
	key: string,
	choices: SidebarCollapseChoices,
	collapseDelegatedChatsByDefault = false,
): boolean {
	if (choices.collapsedProjectKeys?.has(key)) return true;
	return (
		collapseDelegatedChatsByDefault &&
		key.startsWith(DELEGATION_KEY_PREFIX) &&
		!choices.expandedDelegationKeys?.has(key)
	);
}
