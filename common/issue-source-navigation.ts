import type { IssueSource } from './issues.js';
import { issueChatId, issueInvalid, issueRecord, issueSource } from './issue-validation.js';

export type IssueSourceResolution =
  | { readonly kind: 'found'; readonly target: IssueSource }
  | { readonly kind: 'transcript-reloaded' | 'outcome-unavailable'; readonly chatId: string };

export function parseIssueSourceResolution(value: unknown): IssueSourceResolution {
  const raw = issueRecord(value, ['kind', 'target', 'chatId']);
  if (raw.kind === 'found') {
    issueRecord(raw, ['kind', 'target']);
    return { kind: raw.kind, target: issueSource(raw.target) };
  }
  if (raw.kind === 'transcript-reloaded' || raw.kind === 'outcome-unavailable') {
    issueRecord(raw, ['kind', 'chatId']);
    return { kind: raw.kind, chatId: issueChatId(raw.chatId) };
  }
  return issueInvalid('Invalid issue source resolution.');
}
