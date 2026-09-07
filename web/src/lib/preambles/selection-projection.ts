// Client-side draft projection. Mirrors the server's ordered selection
// resolution closely enough to label unsaved rows: missing, disabled, and
// out-of-scope states keep their ID and position. The server projection stays
// authoritative for saved selections; this derives status for added rows.
import type {
	Preamble,
	PreambleId,
	PreambleSelectionProjection,
	PreambleSelectionUnavailableReason,
	PreamblesSnapshot,
} from '$shared/preambles';
import { isProjectPathAncestor, normalizeProjectPath } from '$lib/utils/project-path.js';

export interface DraftSelectionRow {
	readonly id: PreambleId;
	readonly title: string | null;
	readonly reason: PreambleSelectionUnavailableReason | null;
}

export interface ProjectedDraftSelection {
	readonly rows: readonly DraftSelectionRow[];
	readonly eligibleCount: number;
}

function ruleMatches(rule: { projectPath: string; includeNested: boolean }, projectPath: string) {
	const rulePath = normalizeProjectPath(rule.projectPath);
	const chatPath = normalizeProjectPath(projectPath);
	if (!rulePath || !chatPath) return false;
	if (rulePath === chatPath) return true;
	return rule.includeNested && isProjectPathAncestor(rulePath, chatPath);
}

function scopeMatches(preamble: Preamble, projectPath: string): boolean {
	return preamble.scope.type === 'global'
		|| preamble.scope.rules.some((rule) => ruleMatches(rule, projectPath));
}

export function projectDraftSelection(input: {
	readonly draftIds: readonly PreambleId[];
	readonly savedProjection: PreambleSelectionProjection | null;
	readonly catalog: Pick<PreamblesSnapshot, 'preambles'>;
	readonly canonicalProjectPath: string;
}): ProjectedDraftSelection {
	const byId = new Map(input.catalog.preambles.map((preamble) => [preamble.id, preamble]));
	const savedEligible = new Map(
		(input.savedProjection?.eligiblePreambles ?? []).map((entry) => [entry.id, entry.title]),
	);
	const savedUnavailable = new Map(
		(input.savedProjection?.unavailable ?? []).map((entry) => [entry.id, entry.reason]),
	);
	const rows: DraftSelectionRow[] = [];
	for (const id of input.draftIds) {
		const preamble = byId.get(id);
		if (!preamble) {
			rows.push({
				id,
				title: savedEligible.get(id) ?? null,
				reason: savedUnavailable.get(id) ?? 'missing',
			});
			continue;
		}
		if (!preamble.enabled) {
			rows.push({ id, title: preamble.title, reason: 'disabled' });
			continue;
		}
		if (!scopeMatches(preamble, input.canonicalProjectPath)) {
			rows.push({ id, title: preamble.title, reason: 'out-of-scope' });
			continue;
		}
		rows.push({ id, title: preamble.title, reason: null });
	}
	return {
		rows,
		eligibleCount: rows.filter((row) => row.reason === null).length,
	};
}

export function candidateUnavailableReason(
	preamble: Preamble,
	canonicalProjectPath: string,
): Exclude<PreambleSelectionUnavailableReason, 'missing'> | null {
	if (!preamble.enabled) return 'disabled';
	return scopeMatches(preamble, canonicalProjectPath) ? null : 'out-of-scope';
}
