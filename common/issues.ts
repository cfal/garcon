import type { ErrorCode } from './error-codes.js';

export const ISSUE_STATUSES = ['open', 'in-progress', 'in-review', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssueResolution = 'done' | 'canceled';
export type IssuePriority = 0 | 1 | 2 | 3;
export type IssueErrorCode = Extract<ErrorCode, `ISSUE_${string}`>;

export const ISSUE_LIMITS = {
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

export type IssueOwner =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'user'; readonly username: string };

export type IssueActor =
  | { readonly kind: 'chat'; readonly chatId: string; readonly provenance: 'observed' }
  | { readonly kind: 'user'; readonly username: string;
      readonly principalMode: 'authenticated' | 'local'; readonly declaredChatId: string | null };

export interface IssueSource {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

export interface Issue {
  readonly id: string;
  readonly number: number;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly project: string;
  readonly status: IssueStatus;
  readonly resolution: IssueResolution | null;
  readonly priority: IssuePriority;
  readonly labels: readonly string[];
  readonly assignee: IssueOwner | null;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: IssueActor;
}

export interface IssueComment {
  readonly id: string;
  readonly issueId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly body: string | null;
  readonly author: IssueActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface IssueCommentView extends IssueComment {
  readonly canEdit: boolean;
}

export type IssueLinkKind = 'blocks' | 'related';
export interface IssueLink {
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: IssueLinkKind;
}

export type IssueField = 'title' | 'description' | 'project' | 'status' | 'resolution'
  | 'priority' | 'labels' | 'assignee' | 'parentId';
export type IssueFieldChange = {
  [K in IssueField]: { readonly field: K; readonly before: Issue[K]; readonly after: Issue[K] }
}[IssueField];

export interface IssueActivityBase {
  readonly sequence: number;
  readonly issueId: string;
  readonly at: string;
  readonly actor: IssueActor;
  readonly source: IssueSource | null;
}

export type IssueActivity = IssueActivityBase & (
  | { readonly action: 'created'; readonly issue: Issue }
  | { readonly action: 'updated' | 'claimed' | 'released' | 'closed' | 'reopened';
      readonly changes: readonly IssueFieldChange[] }
  | { readonly action: 'comment-added' | 'comment-edited' | 'comment-removed';
      readonly commentId: string; readonly before: string | null; readonly after: string | null }
  | { readonly action: 'linked' | 'unlinked'; readonly kind: IssueLinkKind;
      readonly sourceId: string; readonly targetId: string }
);

export interface IssueSummary extends Omit<Issue, 'description'> {
  readonly blockedByCount: number;
  readonly commentCount: number;
}

export interface IssueListQuery {
  readonly project?: string;
  readonly status?: IssueStatus;
  readonly includeClosed?: boolean;
  readonly priority?: IssuePriority;
  readonly label?: string;
  readonly assignee?: IssueOwner | 'unassigned';
  readonly ready?: boolean;
  readonly query?: string;
  readonly beforeNumber?: number;
  readonly expectedCollectionRevision?: number;
  readonly limit?: number;
}

export interface IssueReadQuery {
  readonly issueId: string;
  readonly includeDescription?: boolean;
  readonly commentLimit?: number;
  readonly beforeCommentSequence?: number;
  readonly expectedCollectionRevision?: number;
}

export interface IssueCommentsQuery {
  readonly issueId: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
  readonly expectedCollectionRevision?: number;
}

export interface IssueHistoryQuery {
  readonly issueId: string;
  readonly limit?: number;
  readonly beforeSequence?: number;
}

export interface IssueCollectionVersion {
  readonly storeId: string;
  readonly collectionRevision: number;
}

export interface IssuePage extends IssueCollectionVersion {
  readonly items: readonly IssueSummary[];
  readonly nextBeforeNumber: number | null;
}

export interface IssueSequencePage<T> extends IssueCollectionVersion {
  readonly items: readonly T[];
  readonly nextBeforeSequence: number | null;
}

export interface IssueDetail extends IssueCollectionVersion {
  readonly issue: Omit<Issue, 'description'> & { readonly description: string | null };
  readonly links: readonly IssueLink[];
  readonly comments: IssueSequencePage<IssueCommentView>;
}

export interface IssueWriteResult extends IssueCollectionVersion {
  readonly success: true;
  readonly issue: Issue;
  readonly comment?: IssueComment;
  readonly relatedIssue?: Issue;
}

export interface IssueCounts extends IssueCollectionVersion {
  readonly counts: Readonly<Record<IssueStatus, number>>;
}

export interface IssueFacets extends IssueCollectionVersion {
  readonly values: readonly string[];
}

export interface IssueBootstrap extends IssueCollectionVersion {
  readonly viewerKey: string;
}

export interface IssueProjectDefault {
  readonly project: string;
  readonly kind: 'repository' | 'folder';
}

export function issueOwnerKey(owner: IssueOwner): string {
  if (owner.kind === 'chat') return `chat:${owner.chatId}`;
  return `user:${owner.username}`;
}

export function issueAssigneeQuery(owner: IssueOwner | 'unassigned'): string {
  return owner === 'unassigned' ? owner : issueOwnerKey(owner);
}
