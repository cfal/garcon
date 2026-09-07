import {
	PREAMBLE_CONTENT_MAX_LENGTH,
	PREAMBLE_AGENT_FILTER_MAX_COUNT,
	PREAMBLE_FILE_CONTEXT_SEPARATOR,
	PREAMBLE_PATH_RULE_MAX_COUNT,
	PREAMBLE_TAG_FILTER_MAX_COUNT,
	PREAMBLE_TAG_MAX_CODE_POINTS,
	PREAMBLE_TITLE_MAX_CODE_POINTS,
	type Preamble,
	type PreambleDefinitionInput,
	type PreambleScope,
	type PreambleTagMatchMode,
} from '$shared/preambles';
import type { AgentId } from '$shared/agents';
import { normalizeTagSlug } from '$lib/utils/tags.js';
import { createRandomId } from '$lib/utils/random-id.js';
import * as m from '$lib/paraglide/messages.js';

export interface PreamblePathRuleDraft {
	readonly key: string;
	projectPath: string;
	includeNested: boolean;
}

export class PreambleFormState {
	enabled = $state(true);
	title = $state('');
	content = $state('');
	scopeType = $state<'global' | 'project-paths'>('global');
	pathRules = $state<PreamblePathRuleDraft[]>([]);
	agentIds = $state<AgentId[]>([]);
	tagFilterMode = $state<PreambleTagMatchMode>('any');
	tagFilterTags = $state<string[]>([]);
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
		return (
			this.scopeGroupError ??
			this.pathRules.map((rule) => this.pathRuleError(rule.key)).find(Boolean) ??
			null
		);
	}

	get scopeGroupError(): string | null {
		if (this.scopeType === 'global') return null;
		if (this.pathRules.length === 0) return m.preambles_path_required();
		if (this.pathRules.length > PREAMBLE_PATH_RULE_MAX_COUNT) {
			return m.preambles_too_many_paths();
		}
		return null;
	}

	get canSave(): boolean {
		return !this.saving && !this.titleError && !this.contentError && !this.scopeError;
	}

	get canAddPath(): boolean {
		return this.pathRules.length < PREAMBLE_PATH_RULE_MAX_COUNT;
	}

	pathRuleError(key: string): string | null {
		if (this.scopeType !== 'project-paths') return null;
		const rule = this.pathRules.find((candidate) => candidate.key === key);
		const projectPath = rule?.projectPath.trim() ?? '';
		if (!projectPath) return m.preambles_path_required();
		const matchingPathCount = this.pathRules.filter(
			(candidate) => candidate.projectPath.trim() === projectPath,
		).length;
		if (matchingPathCount > 1) return m.preambles_duplicate_path();
		return null;
	}

	reset(preamble: Preamble | null): void {
		this.enabled = preamble?.enabled ?? true;
		this.title = preamble?.title ?? '';
		this.content = preamble?.content ?? '';
		this.scopeType = preamble?.scope.type ?? 'global';
		this.pathRules =
			preamble?.scope.type === 'project-paths'
				? preamble.scope.rules.map((rule) => ({ key: createRandomId(), ...rule }))
				: [];
		this.agentIds = preamble ? [...preamble.agentIds] : [];
		this.tagFilterMode = preamble?.tagFilter.mode ?? 'any';
		this.tagFilterTags = preamble ? [...preamble.tagFilter.tags] : [];
		this.saving = false;
		this.error = null;
	}

	addPath(projectPath = ''): string | null {
		if (this.pathRules.length >= PREAMBLE_PATH_RULE_MAX_COUNT) return null;
		const key = createRandomId();
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

	toggleAgent(agentId: AgentId): boolean {
		if (this.agentIds.includes(agentId)) {
			this.agentIds = this.agentIds.filter((candidate) => candidate !== agentId);
			return true;
		}
		if (this.agentIds.length >= PREAMBLE_AGENT_FILTER_MAX_COUNT) return false;
		this.agentIds = [...this.agentIds, agentId];
		return true;
	}

	addTag(raw: string): boolean {
		const tag = normalizeTagSlug(raw);
		const invalid =
			!tag ||
			Array.from(tag).length > PREAMBLE_TAG_MAX_CODE_POINTS ||
			this.tagFilterTags.includes(tag) ||
			this.tagFilterTags.length >= PREAMBLE_TAG_FILTER_MAX_COUNT;
		if (invalid) return false;
		this.tagFilterTags = [...this.tagFilterTags, tag];
		return true;
	}

	removeTag(tag: string): void {
		this.tagFilterTags = this.tagFilterTags.filter((candidate) => candidate !== tag);
	}

	buildDefinition(): PreambleDefinitionInput | null {
		if (!this.canSave) return null;
		return {
			enabled: this.enabled,
			title: this.title.trim(),
			content: this.content,
			agentIds: [...this.agentIds],
			tagFilter: { mode: this.tagFilterMode, tags: [...this.tagFilterTags] },
			scope: this.#buildScope(),
		};
	}

	#buildScope(): PreambleScope {
		if (this.scopeType === 'global') return { type: 'global' };
		return {
			type: 'project-paths',
			rules: this.pathRules.map((rule) => ({
				projectPath: rule.projectPath.trim(),
				includeNested: rule.includeNested,
			})),
		};
	}
}
