export const SIDEBAR_GROUPING_FIELDS = ['executor', 'project', 'activity', 'status'] as const;
export type SidebarGroupingField = (typeof SIDEBAR_GROUPING_FIELDS)[number];

export interface SidebarGroupingSelection {
	field: SidebarGroupingField;
	enabled: boolean;
}

export function defaultSidebarGroupingFields(): SidebarGroupingSelection[] {
	return SIDEBAR_GROUPING_FIELDS.map((field) => ({ field, enabled: false }));
}

export function normalizeSidebarGroupingFields(value: unknown): SidebarGroupingSelection[] {
	const result: SidebarGroupingSelection[] = [];
	const seen = new Set<SidebarGroupingField>();
	for (const entry of Array.isArray(value) ? value : []) {
		if (!entry || typeof entry !== 'object') continue;
		const field = SIDEBAR_GROUPING_FIELDS.find((field) => field === entry.field);
		if (!field || seen.has(field)) continue;
		seen.add(field);
		result.push({ field, enabled: entry.enabled === true });
	}
	for (const field of SIDEBAR_GROUPING_FIELDS) {
		if (!seen.has(field)) result.push({ field, enabled: false });
	}
	return result;
}

export function enabledSidebarGroupingFields(
	selections: readonly SidebarGroupingSelection[],
): SidebarGroupingField[] {
	return selections.filter((selection) => selection.enabled).map((selection) => selection.field);
}
