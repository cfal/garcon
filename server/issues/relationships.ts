import type { Database } from 'bun:sqlite';
import { ISSUE_LIMITS, type Issue } from '../../common/issues.js';
import { issueNumber } from '../../common/issue-validation.js';
import { IssueDomainError } from './errors.js';
import { requireIssue } from './records.js';

export function validateIssueParent(database: Database, issue: Issue): void {
  const visited = new Set([issue.id]);
  let parentId = issue.parentId;
  let ancestorDepth = 0;
  while (parentId) {
    if (visited.has(parentId)) throw new IssueDomainError('ISSUE_RELATIONSHIP_CYCLE', 'Issue parents must not form a cycle.');
    visited.add(parentId);
    ancestorDepth += 1;
    if (ancestorDepth > ISSUE_LIMITS.ancestry) throw new IssueDomainError('ISSUE_LIMIT_REACHED', 'Issue ancestry is too deep.');
    parentId = requireIssue(database, parentId).parentId;
  }
  const descendantDepth = database.query<{ depth: number }, [number, number]>(`
    WITH RECURSIVE descendants(number,depth) AS (
      SELECT ?,0 UNION ALL
      SELECT i.number,d.depth+1 FROM issues i JOIN descendants d ON i.parent_number=d.number WHERE d.depth<=?
    ) SELECT max(depth) AS depth FROM descendants
  `).get(issue.number, ISSUE_LIMITS.ancestry)?.depth ?? 0;
  if (ancestorDepth + descendantDepth > ISSUE_LIMITS.ancestry) {
    throw new IssueDomainError('ISSUE_LIMIT_REACHED', 'Issue ancestry is too deep.');
  }
}

export function requireLinkCapacity(database: Database, source: number, target: number): void {
  for (const number of [source, target]) {
    const count = database.query<{ count: number }, [number, number]>(
      'SELECT count(*) AS count FROM issue_links WHERE source_number=? OR target_number=?',
    ).get(number, number)?.count ?? 0;
    if (count >= ISSUE_LIMITS.links) throw new IssueDomainError('ISSUE_LIMIT_REACHED', 'An issue can have at most 100 links.');
  }
}

export function requireNoBlockingCycle(database: Database, sourceId: string, targetId: string): void {
  const reached = database.query<{ number: number }, [number, number]>(`
    WITH RECURSIVE reachable(number) AS (
      SELECT ? UNION
      SELECT l.target_number FROM issue_links l JOIN reachable r ON l.source_number=r.number WHERE l.kind='blocks'
    ) SELECT number FROM reachable WHERE number=? LIMIT 1
  `).get(issueNumber(targetId), issueNumber(sourceId));
  if (reached) throw new IssueDomainError('ISSUE_RELATIONSHIP_CYCLE', 'Blocking links must not form a cycle.');
}
