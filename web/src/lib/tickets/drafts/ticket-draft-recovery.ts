import {
	parseHttpTicketMutationRequest,
	type HttpTicketMutationRequest,
	type TicketMutationPayload,
} from '$shared/ticket-commands';
import {
	ticketId,
	ticketInteger,
	ticketRecord,
	ticketString,
	ticketUuid,
} from '$shared/ticket-validation';

export interface TicketDraftPartition {
	readonly storeId: string;
	readonly viewerKey: string;
}

export const TICKET_DRAFT_FIELDS = [
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
export type TicketDraftField = (typeof TICKET_DRAFT_FIELDS)[number];
export type TicketDraftFields = Partial<Record<TicketDraftField, string>>;
export type TicketDraftKind =
	'create' | 'fields' | 'comment' | 'comment-edit' | 'close' | 'mutation';

export interface FrozenTicketSubmission {
	readonly version: number;
	readonly request: HttpTicketMutationRequest;
}

export interface TicketDraftSnapshot extends TicketDraftPartition {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly kind: TicketDraftKind;
	readonly ticketId: string | null;
	readonly commentId: string | null;
	readonly baseRevision: number | null;
	readonly version: number;
	readonly fields: TicketDraftFields;
	readonly baseFields: TicketDraftFields;
	readonly frozen: FrozenTicketSubmission | null;
}

export interface TicketRecoveryEntry {
	readonly key: string;
	readonly raw: string;
	readonly draft: TicketDraftSnapshot | null;
}

export interface TicketRecoveryPort {
	partitions(viewerKey: string): TicketDraftPartition[];
	list(partition: TicketDraftPartition): TicketRecoveryEntry[];
	write(draft: TicketDraftSnapshot): void;
	remove(partition: TicketDraftPartition, id: string): void;
	discard(partition: TicketDraftPartition, key: string): void;
}

const prefix = 'garcon-ticket-draft-v1:';
export const TICKET_RECOVERY_CAPACITY = 20;
const partitionPrefix = (partition: TicketDraftPartition) =>
	`${prefix}${encodeURIComponent(JSON.stringify([partition.storeId, partition.viewerKey]))}:`;
const draftKey = (draft: TicketDraftSnapshot) =>
	partitionPrefix(draft) + encodeURIComponent(draft.id);

export function requireDraftMutation(
	draft: Pick<TicketDraftSnapshot, 'kind' | 'ticketId' | 'commentId'>,
	payload: TicketMutationPayload,
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
		(action === 'create' ? draft.ticketId !== null : payload.ticketId !== draft.ticketId) ||
		(action === 'comment-edit' && payload.commentId !== draft.commentId)
	) {
		throw new Error('Mutation does not belong to this editor');
	}
}

export function parseTicketDraft(value: unknown): TicketDraftSnapshot {
	const raw = ticketRecord(value, [
		'schemaVersion',
		'storeId',
		'viewerKey',
		'id',
		'kind',
		'ticketId',
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
		throw new Error('Unrecognized ticket recovery format');
	}
	const storeId = ticketUuid(raw.storeId, 'storeId');
	const viewerKey = ticketString(raw.viewerKey, 'viewerKey');
	const id = ticketString(raw.id, 'draftId');
	if (!viewerKey || viewerKey.length > 2048 || !id || id.length > 256)
		throw new Error('Invalid draft identity');
	const fields = ticketRecord(raw.fields, TICKET_DRAFT_FIELDS);
	const parsedFields: TicketDraftFields = {};
	const base = ticketRecord(raw.baseFields, TICKET_DRAFT_FIELDS);
	const baseFields: TicketDraftFields = {};
	for (const field of TICKET_DRAFT_FIELDS) {
		if (fields[field] !== undefined) parsedFields[field] = ticketString(fields[field], field);
		if (base[field] !== undefined) baseFields[field] = ticketString(base[field], field);
	}
	let frozen: FrozenTicketSubmission | null = null;
	const version = ticketInteger(raw.version, 'version', 0);
	if (raw.frozen !== null) {
		const submission = ticketRecord(raw.frozen, ['version', 'request']);
		frozen = {
			version: ticketInteger(submission.version, 'submittedVersion', 0, version),
			request: parseHttpTicketMutationRequest(submission.request),
		};
		if (frozen.request.expectedStoreId !== storeId)
			throw new Error('Draft submission belongs to another store');
	}
	const target = raw.ticketId === null ? null : ticketId(raw.ticketId);
	const commentId = raw.commentId === null ? null : ticketUuid(raw.commentId, 'commentId');
	const kind = raw.kind as TicketDraftKind;
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
	if (frozen) requireDraftMutation({ kind, ticketId: target, commentId }, frozen.request.payload);
	return {
		schemaVersion: 1,
		storeId,
		viewerKey,
		id,
		kind,
		ticketId: target,
		commentId,
		version,
		fields: parsedFields,
		baseFields,
		frozen,
		baseRevision: raw.baseRevision === null ? null : ticketInteger(raw.baseRevision, 'baseRevision'),
	};
}

export function createTicketRecovery(storage: () => Storage): TicketRecoveryPort {
	return {
		partitions(viewerKey) {
			const target = storage();
			const partitions = new Map<string, TicketDraftPartition>();
			for (let index = 0; index < target.length; index++) {
				const key = target.key(index);
				if (!key?.startsWith(prefix)) continue;
				try {
					const tuple = JSON.parse(decodeURIComponent(key.slice(prefix.length).split(':')[0]!));
					if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[1] !== viewerKey) continue;
					const storeId = ticketUuid(tuple[0], 'storeId');
					partitions.set(storeId, { storeId, viewerKey });
				} catch {
					/* Unrecognized partition keys cannot expose another account's recovery. */
				}
			}
			return [...partitions.values()];
		},
		list(partition) {
			const target = storage();
			const entries: TicketRecoveryEntry[] = [];
			const scope = partitionPrefix(partition);
			for (let index = 0; index < target.length; index++) {
				const key = target.key(index);
				if (!key?.startsWith(scope)) continue;
				const raw = target.getItem(key);
				if (raw === null) continue;
				let draft: TicketDraftSnapshot | null = null;
				try {
					const parsed = parseTicketDraft(JSON.parse(raw));
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
			if (target.getItem(key) === null && this.list(draft).length >= TICKET_RECOVERY_CAPACITY) {
				throw new Error(
					'Ticket draft recovery is full. Copy or discard a retained draft before saving another.',
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

export const browserTicketRecovery = createTicketRecovery(() => globalThis.sessionStorage);
