import {
	PREAMBLE_CONTENT_MAX_LENGTH,
	PREAMBLE_FILE_CONTEXT_SEPARATOR,
	PREAMBLE_PATH_RULE_MAX_COUNT,
	PREAMBLE_TITLE_MAX_CODE_POINTS,
	type Preamble,
	type PreambleDefinitionInput,
} from '$shared/preambles';
import { normalizeProjectPath } from '$lib/utils/project-path.js';
import * as m from '$lib/paraglide/messages.js';

export interface PreamblePathRuleDraft {
	readonly key: string;
	projectPath: string;
	includeNested: boolean;
}

export class PreambleFormState {
	title = $state('');
	content = $state('');
	scopeType = $state<'global' | 'project-paths'>('global');
	pathRules = $state<PreamblePathRuleDraft[]>([]);
	saving = $state(false);
	error = $state<string | null>(null);

	get titleError(): string | null {
		const title = this.title.trim();
		if (!title) return m.preambles_title_required();
		if (/\r|\n/u.test(title)) return m.preambles_title_one_line();
		if (Array.from(title).length > PREAMBLE_TITLE_MAX_CODE_POINTS) {
			return m.preambles_title_too_long();
		}
		return null;
	}

	get contentError(): string | null {
		if (!this.content.trim()) return m.preambles_content_required();
		if (this.content.length > PREAMBLE_CONTENT_MAX_LENGTH) {
			return m.preambles_content_too_long();
		}
		if (this.content.includes(PREAMBLE_FILE_CONTEXT_SEPARATOR)) {
			return m.preambles_content_reserved_separator();
		}
		return null;
	}

	get scopeError(): string | null {
		if (this.scopeType === 'global') return null;
		if (this.pathRules.length === 0) return m.preambles_path_required();
		if (this.pathRules.length > PREAMBLE_PATH_RULE_MAX_COUNT) {
			return m.preambles_too_many_paths();
		}
		const paths = this.pathRules.map((rule) => normalizeProjectPath(rule.projectPath));
		if (paths.some((projectPath) => !projectPath)) return m.preambles_path_required();
		if (new Set(paths).size !== paths.length) return m.preambles_duplicate_path();
		return null;
	}

	get canSave(): boolean {
		return !this.saving && !this.titleError && !this.contentError && !this.scopeError;
	}

	reset(preamble: Preamble | null): void {
		this.title = preamble?.title ?? '';
		this.content = preamble?.content ?? '';
		this.scopeType = preamble?.scope.type ?? 'global';
		this.pathRules = preamble?.scope.type === 'project-paths'
			? preamble.scope.rules.map((rule) => ({ key: crypto.randomUUID(), ...rule }))
			: [];
		this.saving = false;
		this.error = null;
	}

	addPath(projectPath = ''): string | null {
		if (this.pathRules.length >= PREAMBLE_PATH_RULE_MAX_COUNT) return null;
		const key = crypto.randomUUID();
		this.pathRules.push({ key, projectPath, includeNested: false });
		return key;
	}

	removePath(key: string): void {
		this.pathRules = this.pathRules.filter((rule) => rule.key !== key);
	}

	setPath(key: string, projectPath: string): void {
		const rule = this.pathRules.find((candidate) => candidate.key === key);
		if (rule) rule.projectPath = projectPath;
	}

	buildDefinition(): PreambleDefinitionInput | null {
		if (!this.canSave) return null;
		return {
			title: this.title.trim(),
			content: this.content,
			scope: this.scopeType === 'global'
				? { type: 'global' }
				: {
						type: 'project-paths',
						rules: this.pathRules.map((rule) => ({
							projectPath: rule.projectPath.trim(),
							includeNested: rule.includeNested,
						})),
					},
		};
	}
}
