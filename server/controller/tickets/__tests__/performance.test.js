import { expect, test } from 'bun:test';
import { ticketFixture, caller } from './fixture.js';
import { ticketAuthorityKey } from '../contracts.js';

test('bounds indexed reads on a synthetic 10k-ticket, 50k-comment workspace', () => {
  const fixture = ticketFixture();
  try {
    const seed = fixture.create().ticket;
    fixture.store.transaction((database) => {
      const insertTicket = database.query(`INSERT INTO tickets
        (number,revision,project,status,resolution,priority,payload_json) VALUES (?,1,?,?,NULL,2,?)`);
      const insertComment = database.query('INSERT INTO ticket_comments VALUES (?,?,?,1,?,NULL,?)');
      for (let number = 1; number <= 10000; number++) {
        const ticket = { ...seed, id: `G-${number}`, number, project: `Project-${number % 10}`,
          status: number % 3 === 0 ? 'in-progress' : 'open' };
        if (number !== 1) insertTicket.run(number, ticket.project, ticket.status, JSON.stringify(ticket));
        for (let sequence = 1; sequence <= 5; sequence++) {
          const id = `11111111-1111-4111-8111-${String(number * 5 + sequence).padStart(12, '0')}`;
          const comment = { id, ticketId: ticket.id, sequence, revision: 1, body: 'Synthetic discussion.',
            author: seed.createdBy, createdAt: seed.createdAt, updatedAt: seed.updatedAt, deletedAt: null };
          insertComment.run(id, number, sequence, ticketAuthorityKey(caller.authority), JSON.stringify(comment));
        }
      }
    });
    const plans = fixture.store.read((database) => [
      database.query("EXPLAIN QUERY PLAN SELECT * FROM tickets WHERE project=? AND status=? ORDER BY number DESC LIMIT 50").all('Project-1', 'open'),
      database.query('EXPLAIN QUERY PLAN SELECT * FROM tickets WHERE assignee_key=? ORDER BY number DESC LIMIT 50').all('user:local'),
    ]);
    expect(JSON.stringify(plans[0])).toContain('tickets_project_status');
    expect(JSON.stringify(plans[1])).toContain('tickets_assignee');
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
      const detail = fixture.service.read({ ticketId: 'G-10000' }, caller.authority);
      const detailElapsed = performance.now() - started;
      expect(detail.comments.items).toHaveLength(5);
      if (iteration > 0) { listTimes.push(listElapsed); detailTimes.push(detailElapsed); }
    }
    const p95 = (times) => times.sort((a, b) => a - b)[18].toFixed(1);
    console.info(`Tickets synthetic read p95: list ${p95(listTimes)}ms; detail ${p95(detailTimes)}ms.`);
  } finally { fixture.cleanup(); }
});
