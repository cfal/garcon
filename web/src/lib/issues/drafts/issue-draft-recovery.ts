import {
	parseHttpIssueMutationRequest,
	type HttpIssueMutationRequest,
	type IssueMutationPayload,
} from '$shared/issue-commands';
import {
	issueId,
	issueInteger,
	issueRecord,
	issueString,
	issueUuid,
} from '$shared/issue-validation';

export interface IssueDraftPartition {
	readonly storeId: string;
	readonly viewerKey: string;
}

export const ISSUE_DRAFT_FIELDS = [
	'title',
	'description',
	'project',
	'priority',
	'labels',
	'assignee',
	'parentId',
	'body',
	'resolution',
] as const;
export type IssueDraftField = (typeof ISSUE_DRAFT_FIELDS)[number];
export type IssueDraftFields = Partial<Record<IssueDraftField, string>>;
export type IssueDraftKind =
	'create' | 'fields' | 'comment' | 'comment-edit' | 'close' | 'mutation';

export interface FrozenIssueSubmission {
	readonly version: number;
	readonly request: HttpIssueMutationRequest;
}

export interface IssueDraftSnapshot extends IssueDraftPartition {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly kind: IssueDraftKind;
	readonly issueId: string | null;
	readonly commentId: string | null;
	readonly baseRevision: number | null;
	readonly version: number;
	readonly fields: IssueDraftFields;
	readonly baseFields: IssueDraftFields;
	readonly frozen: FrozenIssueSubmission | null;
}

export interface IssueRecoveryEntry {
	readonly key: string;
	readonly raw: string;
	readonly draft: IssueDraftSnapshot | null;
}

export interface IssueRecoveryPort {
	partitions(viewerKey: string): IssueDraftPartition[];
	list(partition: IssueDraftPartition): IssueRecoveryEntry[];
	write(draft: IssueDraftSnapshot): void;
	remove(partition: IssueDraftPartition, id: string): void;
	discard(partition: IssueDraftPartition, key: string): void;
}

const prefix = 'garcon-issue-draft-v1:';
export const ISSUE_RECOVERY_CAPACITY = 20;
const partitionPrefix = (partition: IssueDraftPartition) =>
	`${prefix}${encodeURIComponent(JSON.stringify([partition.storeId, partition.viewerKey]))}:`;
const draftKey = (draft: IssueDraftSnapshot) =>
	partitionPrefix(draft) + encodeURIComponent(draft.id);

export function requireDraftMutation(
	draft: Pick<IssueDraftSnapshot, 'kind' | 'issueId' | 'commentId'>,
	payload: IssueMutationPayload,
): void {
	const action = payload.action;
	const matchesKind =
		draft.kind === 'create'
			? action === 'create'
			: draft.kind === 'fields'
				? action === 'update'
				: draft.kind === 'comment'
					? action === 'comment'
					: draft.kind === 'comment-edit'
						? action === 'comment-edit'
						: draft.kind === 'close'
							? action === 'close'
							: !['create', 'comment', 'comment-edit', 'close'].includes(action);
	if (
		!matchesKind ||
		(action === 'create' ? draft.issueId !== null : payload.issueId !== draft.issueId) ||
		(action === 'comment-edit' && payload.commentId !== draft.commentId)
	) {
		throw new Error('Mutation does not belong to this editor');
	}
}

export function parseIssueDraft(value: unknown): IssueDraftSnapshot {
	const raw = issueRecord(value, [
		'schemaVersion',
		'storeId',
		'viewerKey',
		'id',
		'kind',
		'issueId',
		'commentId',
		'baseRevision',
		'version',
		'fields',
		'baseFields',
		'frozen',
	]);
	if (
		raw.schemaVersion !== 1 ||
		!['create', 'fields', 'comment', 'comment-edit', 'close', 'mutation'].includes(String(raw.kind))
	) {
		throw new Error('Unrecognized issue recovery format');
	}
	const storeId = issueUuid(raw.storeId, 'storeId');
	const viewerKey = issueString(raw.viewerKey, 'viewerKey');
	const id = issueString(raw.id, 'draftId');
	if (!viewerKey || viewerKey.length > 2048 || !id || id.length > 256)
		throw new Error('Invalid draft identity');
	const fields = issueRecord(raw.fields, ISSUE_DRAFT_FIELDS);
	const parsedFields: IssueDraftFields = {};
	const base = issueRecord(raw.baseFields, ISSUE_DRAFT_FIELDS);
	const baseFields: IssueDraftFields = {};
	for (const field of ISSUE_DRAFT_FIELDS) {
		if (fields[field] !== undefined) parsedFields[field] = issueString(fields[field], field);
		if (base[field] !== undefined) baseFields[field] = issueString(base[field], field);
	}
	let frozen: FrozenIssueSubmission | null = null;
	const version = issueInteger(raw.version, 'version', 0);
	if (raw.frozen !== null) {
		const submission = issueRecord(raw.frozen, ['version', 'request']);
		frozen = {
			version: issueInteger(submission.version, 'submittedVersion', 0, version),
			request: parseHttpIssueMutationRequest(submission.request),
		};
		if (frozen.request.expectedStoreId !== storeId)
			throw new Error('Draft submission belongs to another store');
	}
	const target = raw.issueId === null ? null : issueId(raw.issueId);
	const commentId = raw.commentId === null ? null : issueUuid(raw.commentId, 'commentId');
	const kind = raw.kind as IssueDraftKind;
	const expectedId = kind === 'create' ? 'new' : `${kind}:${target}:${commentId ?? ''}`;
	if (
		(raw.kind === 'create') !== (target === null) ||
		(raw.kind === 'comment-edit' && commentId === null) ||
		(raw.kind !== 'comment-edit' && commentId !== null) ||
		id !== expectedId ||
		frozen?.request.fromChatId !== undefined
	) {
		throw new Error('Draft target disagrees with its editor');
	}
	if (frozen) requireDraftMutation({ kind, issueId: target, commentId }, frozen.request.payload);
	return {
		schemaVersion: 1,
		storeId,
		viewerKey,
		id,
		kind,
		issueId: target,
		commentId,
		version,
		fields: parsedFields,
		baseFields,
		frozen,
		baseRevision: raw.baseRevision === null ? null : issueInteger(raw.baseRevision, 'baseRevision'),
	};
}

export function createIssueRecovery(storage: () => Storage): IssueRecoveryPort {
	return {
		partitions(viewerKey) {
			const target = storage();
			const partitions = new Map<string, IssueDraftPartition>();
			for (let index = 0; index < target.length; index++) {
				const key = target.key(index);
				if (!key?.startsWith(prefix)) continue;
				try {
					const tuple = JSON.parse(decodeURIComponent(key.slice(prefix.length).split(':')[0]!));
					if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[1] !== viewerKey) continue;
					const storeId = issueUuid(tuple[0], 'storeId');
					partitions.set(storeId, { storeId, viewerKey });
				} catch {
					/* Unrecognized partition keys cannot expose another account's recovery. */
				}
			}
			return [...partitions.values()];
		},
		list(partition) {
			const target = storage();
			const entries: IssueRecoveryEntry[] = [];
			const scope = partitionPrefix(partition);
			for (let index = 0; index < target.length; index++) {
				const key = target.key(index);
				if (!key?.startsWith(scope)) continue;
				const raw = target.getItem(key);
				if (raw === null) continue;
				let draft: IssueDraftSnapshot | null = null;
				try {
					const parsed = parseIssueDraft(JSON.parse(raw));
					if (draftKey(parsed) !== key) throw new Error('Recovery key disagrees');
					draft = parsed;
				} catch {
					/* Unreadable text remains available for explicit recovery. */
				}
				entries.push({ key, raw, draft });
			}
			return entries;
		},
		write(draft) {
			const target = storage();
			const key = draftKey(draft);
			if (target.getItem(key) === null && this.list(draft).length >= ISSUE_RECOVERY_CAPACITY) {
				throw new Error(
					'Issue draft recovery is full. Copy or discard a retained draft before saving another.',
				);
			}
			target.setItem(key, JSON.stringify(draft));
		},
		remove(partition, id) {
			storage().removeItem(partitionPrefix(partition) + encodeURIComponent(id));
		},
		discard(partition, key) {
			if (!key.startsWith(partitionPrefix(partition)))
				throw new Error('Recovery entry belongs to another account or store');
			storage().removeItem(key);
		},
	};
}

export const browserIssueRecovery = createIssueRecovery(() => globalThis.sessionStorage);
