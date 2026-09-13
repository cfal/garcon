import type { ErrorCode } from './error-codes.js';

export const TICKET_STATUSES = ['open', 'in-progress', 'in-review', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketResolution = 'done' | 'canceled';
export type TicketPriority = 0 | 1 | 2 | 3;
export type TicketErrorCode = Extract<ErrorCode, `TICKET_${string}`>;

export const TICKET_LIMITS = {
  titleCodePoints: 240,
  projectBytes: 4096,
  bodyBytes: 48 * 1024,
  labelCodePoints: 64,
  labels: 20,
  refBytes: 128,
  requestBytes: 64 * 1024,
  httpBytes: 1024 * 1024,
  markupBytes: 48 * 1024,
  page: 100,
  defaultPage: 50,
  links: 100,
  ancestry: 100,
} as const;

export type TicketOwner =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'user'; readonly username: string };

export type TicketActor =
  | { readonly kind: 'chat'; readonly chatId: string; readonly provenance: 'observed' }
  | { readonly kind: 'user'; readonly username: string;
      readonly principalMode: 'authenticated' | 'local'; readonly declaredChatId: string | null };

export interface TicketSource {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

export interface Ticket {
  readonly id: string;
  readonly number: number;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly project: string;
  readonly status: TicketStatus;
  readonly resolution: TicketResolution | null;
  readonly priority: TicketPriority;
  readonly labels: readonly string[];
  readonly assignee: TicketOwner | null;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: TicketActor;
}

export interface TicketComment {
  readonly id: string;
  readonly ticketId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly body: string | null;
  readonly author: TicketActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface TicketCommentView extends TicketComment {
  readonly canEdit: boolean;
}

export type TicketLinkKind = 'blocks' | 'related';
export interface TicketLink {
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: TicketLinkKind;
}

export type TicketField = 'title' | 'description' | 'project' | 'status' | 'resolution'
  | 'priority' | 'labels' | 'assignee' | 'parentId';
export type TicketFieldChange = {
  [K in TicketField]: { readonly field: K; readonly before: Ticket[K]; readonly after: Ticket[K] }
}[TicketField];

export interface TicketActivityBase {
  readonly sequence: number;
  readonly ticketId: string;
  readonly at: string;
  readonly actor: TicketActor;
  readonly source: TicketSource | null;
}

export type TicketActivity = TicketActivityBase & (
  | { readonly action: 'created'; readonly ticket: Ticket }
  | { readonly action: 'updated' | 'claimed' | 'released' | 'closed' | 'reopened';
      readonly changes: readonly TicketFieldChange[] }
  | { readonly action: 'comment-added' | 'comment-edited' | 'comment-removed';
      readonly commentId: string; readonly before: string | null; readonly after: string | null }
  | { readonly action: 'linked' | 'unlinked'; readonly kind: TicketLinkKind;
      readonly sourceId: string; readonly targetId: string }
);

export interface TicketSummary extends Omit<Ticket, 'description'> {
  readonly blockedByCount: number;
  readonly commentCount: number;
}

export interface TicketListQuery {
  readonly project?: string;
  readonly status?: TicketStatus;
  readonly includeClosed?: boolean;
  readonly priority?: TicketPriority;
  readonly label?: string;
  readonly assignee?: TicketOwner | 'unassigned';
  readonly ready?: boolean;
  readonly query?: string;
  readonly beforeNumber?: number;
  readonly expectedCollectionRevision?: number;
  readonly limit?: number;
}

export interface TicketReadQuery {
  readonly ticketId: string;
  readonly includeDescription?: boolean;
  readonly commentLimit?: number;
  readonly beforeCommentSequence?: number;
  readonly expectedCollectionRevision?: number;
}

export interface TicketCommentsQuery {
  readonly ticketId: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
  readonly expectedCollectionRevision?: number;
}

export interface TicketHistoryQuery {
  readonly ticketId: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
}

export interface TicketCollectionVersion {
  readonly storeId: string;
  readonly collectionRevision: number;
}

export interface TicketPage extends TicketCollectionVersion {
  readonly items: readonly TicketSummary[];
  readonly nextBeforeNumber: number | null;
}

export interface TicketSequencePage<T> extends TicketCollectionVersion {
  readonly items: readonly T[];
  readonly nextBeforeSequence: number | null;
}

export interface TicketDetail extends TicketCollectionVersion {
  readonly ticket: Omit<Ticket, 'description'> & { readonly description: string | null };
  readonly links: readonly TicketLink[];
  readonly comments: TicketSequencePage<TicketCommentView>;
}

export interface TicketWriteResult extends TicketCollectionVersion {
  readonly success: true;
  readonly ticket: Ticket;
  readonly comment?: TicketComment;
  readonly relatedTicket?: Ticket;
}

export interface TicketCounts extends TicketCollectionVersion {
  readonly counts: Readonly<Record<TicketStatus, number>>;
}

export interface TicketFacets extends TicketCollectionVersion {
  readonly values: readonly string[];
}

export interface TicketBootstrap extends TicketCollectionVersion {
  readonly viewerKey: string;
}

export interface TicketProjectDefault {
  readonly project: string;
  readonly kind: 'repository' | 'folder';
}

export function ticketOwnerKey(owner: TicketOwner): string {
  if (owner.kind === 'chat') return `chat:${owner.chatId}`;
  return `user:${owner.username}`;
}

export function ticketAssigneeQuery(owner: TicketOwner | 'unassigned'): string {
  return owner === 'unassigned' ? owner : ticketOwnerKey(owner);
}
