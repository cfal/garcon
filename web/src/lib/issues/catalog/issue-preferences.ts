import { parseIssueListQuery } from '$shared/issue-query';
import type { IssueListQuery } from '$shared/issues';
import type { IssueLayout } from './issue-collection.js';

export interface IssuePreferences {
	readonly layout: IssueLayout;
	readonly query: IssueListQuery;
}
export interface IssuePreferencesPort {
	read(): IssuePreferences;
	write(preferences: IssuePreferences): void;
}
const key = 'garcon-issues-preferences-v1';
export const browserIssuePreferences: IssuePreferencesPort = {
	read() {
		try {
			const raw = JSON.parse(globalThis.localStorage.getItem(key) ?? 'null');
			if (raw?.version !== 1 || (raw.layout !== 'list' && raw.layout !== 'board'))
				return { layout: 'list', query: {} };
			const {
				beforeNumber: _cursor,
				expectedCollectionRevision: _revision,
				limit: _limit,
				...query
			} = parseIssueListQuery(raw.query);
			return { layout: raw.layout, query };
		} catch {
			return { layout: 'list', query: {} };
		}
	},
	write(preferences) {
		try {
			globalThis.localStorage.setItem(key, JSON.stringify({ version: 1, ...preferences }));
		} catch {
			/* Preferences are optional; drafts have a separate recovery owner. */
		}
	},
};
