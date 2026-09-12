import { expect, test } from 'bun:test';
import { issueFixture, caller } from './fixture.js';
import { issueAuthorityKey } from '../contracts.js';

test('bounds indexed reads on a synthetic 10k-issue, 50k-comment workspace', () => {
  const fixture = issueFixture();
  try {
    const seed = fixture.create().issue;
    fixture.store.transaction((database) => {
      const insertIssue = database.query(`INSERT INTO issues
        (number,revision,project,status,resolution,priority,payload_json) VALUES (?,1,?,?,NULL,2,?)`);
      const insertComment = database.query('INSERT INTO issue_comments VALUES (?,?,?,1,?,NULL,?)');
      for (let number = 1; number <= 10000; number++) {
        const issue = { ...seed, id: `ISS-${number}`, number, project: `Project-${number % 10}`,
          status: number % 3 === 0 ? 'in-progress' : 'open' };
        if (number !== 1) insertIssue.run(number, issue.project, issue.status, JSON.stringify(issue));
        for (let sequence = 1; sequence <= 5; sequence++) {
          const id = `11111111-1111-4111-8111-${String(number * 5 + sequence).padStart(12, '0')}`;
          const comment = { id, issueId: issue.id, sequence, revision: 1, body: 'Synthetic discussion.',
            author: seed.createdBy, createdAt: seed.createdAt, updatedAt: seed.updatedAt, deletedAt: null };
          insertComment.run(id, number, sequence, issueAuthorityKey(caller.authority), JSON.stringify(comment));
        }
      }
    });
    const plans = fixture.store.read((database) => [
      database.query("EXPLAIN QUERY PLAN SELECT * FROM issues WHERE project=? AND status=? ORDER BY number DESC LIMIT 50").all('Project-1', 'open'),
      database.query('EXPLAIN QUERY PLAN SELECT * FROM issues WHERE assignee_key=? ORDER BY number DESC LIMIT 50').all('user:local'),
    ]);
    expect(JSON.stringify(plans[0])).toContain('issues_project_status');
    expect(JSON.stringify(plans[1])).toContain('issues_assignee');
    const listTimes = [];
    const detailTimes = [];
    for (let iteration = 0; iteration < 21; iteration++) {
      let started = performance.now();
      const page = fixture.service.list({ project: 'Project-1', status: 'open' });
      const listElapsed = performance.now() - started;
      expect(page.items).toHaveLength(50);
      expect(page.nextBeforeNumber).not.toBeNull();
      expect(page.items.every((item) => item.commentCount === 5)).toBe(true);
      started = performance.now();
      const detail = fixture.service.read({ issueId: 'ISS-10000' }, caller.authority);
      const detailElapsed = performance.now() - started;
      expect(detail.comments.items).toHaveLength(5);
      if (iteration > 0) { listTimes.push(listElapsed); detailTimes.push(detailElapsed); }
    }
    const p95 = (times) => times.sort((a, b) => a - b)[18].toFixed(1);
    console.info(`Issues synthetic read p95: list ${p95(listTimes)}ms; detail ${p95(detailTimes)}ms.`);
  } finally { fixture.cleanup(); }
});
