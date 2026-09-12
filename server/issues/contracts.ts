import { createHash } from 'node:crypto';
import type { MarkupIssueMutationPayload, IssueMutationPayload } from '../../common/issue-commands.js';
import type { IssueActor, IssueOwner, IssueSource } from '../../common/issues.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { issueActor, issueInvalid, issueOwner } from '../../common/issue-validation.js';
import { validateIssueInput } from './errors.js';

export type IssueAuthority =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'principal'; readonly mode: 'authenticated' | 'local'; readonly key: string };

export interface IssueCaller {
  readonly authority: IssueAuthority;
  readonly actor: IssueActor;
  readonly owner: IssueOwner;
}

export interface IssueMutationContext extends IssueCaller {
  readonly expectedStoreId: string;
  readonly source: IssueSource | null;
  readonly operationKey: string;
  readonly fingerprint: string;
}

export function issueAuthorityKey(authority: IssueAuthority): string {
  if (authority.kind === 'chat') return JSON.stringify(['chat', authority.chatId]);
  return JSON.stringify(['principal', authority.mode, authority.key]);
}

export function deriveIssueCaller(principal: ServerPrincipal, fromChatId?: string): IssueCaller {
  const actor: IssueActor = { kind: 'user', username: principal.username,
    principalMode: principal.mode, declaredChatId: fromChatId ?? null };
  const authority: IssueAuthority = { kind: 'principal', mode: principal.mode, key: principal.key };
  const owner: IssueOwner = fromChatId
    ? { kind: 'chat', chatId: fromChatId }
    : { kind: 'user', username: principal.username };
  return validateIssueCaller({ actor, authority, owner });
}

export function validateIssueCaller(caller: IssueCaller): IssueCaller {
  return validateIssueInput(() => {
    const actor = issueActor(caller.actor);
    const owner = issueOwner(caller.owner);
    if (actor.kind === 'user' && caller.actor.kind === 'user' && actor.username !== caller.actor.username) {
      return issueInvalid('The authenticated username must be a canonical issue identity.');
    }
    return { authority: caller.authority, actor, owner };
  });
}

export function issueFingerprint(payload: IssueMutationPayload | MarkupIssueMutationPayload, actor: IssueActor): string {
  return createHash('sha256').update(JSON.stringify([payload, actor])).digest('hex');
}

export function markupIssueContext(expectedStoreId: string, source: IssueSource,
  ref: string, payload: MarkupIssueMutationPayload): IssueMutationContext {
  const actor: IssueActor = { kind: 'chat', chatId: source.chatId, provenance: 'observed' };
  return { actor, authority: { kind: 'chat', chatId: source.chatId },
    owner: { kind: 'chat', chatId: source.chatId }, expectedStoreId, source,
    operationKey: JSON.stringify(['markup', source.chatId, ref]), fingerprint: issueFingerprint(payload, actor) };
}
