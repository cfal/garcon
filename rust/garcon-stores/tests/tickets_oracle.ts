import { deriveTicketCaller } from '../../../server/controller/tickets/contracts.ts';
import { TicketService } from '../../../server/controller/tickets/service.ts';
import { TicketStore } from '../../../server/controller/tickets/store.ts';

const [mode, directory] = Bun.argv.slice(2);
const store = new TicketStore(directory);
const service = new TicketService(store, {
  chatExists: () => false,
  commandsEnabled: () => true,
  now: () => '2025-01-02T00:00:00.000Z',
});
const caller = deriveTicketCaller({ mode: 'authenticated', key: 'fixture-owner', username: 'fixture-user',
  expiresAtMs: 9_000_000_000_000, credentialRevision: 1, sessionId: 'fixture-session' });

const write = (sequence: number, payload: unknown) => service.executeHttp({
  requestId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  expectedStoreId: store.storeId,
  payload,
}, caller);
const first = { action: 'create', input: { title: 'Bun ticket', project: 'project', labels: ['beta', 'alpha'],
  assignee: { kind: 'user', ownerKey: 'fixture-owner' } } };
const second = { action: 'create', input: { title: 'Rust ticket', project: 'project', parentId: 'G-1' } };
const close = { action: 'close', ticketId: 'G-1', expectedRevision: 1, comment: 'Rust closure' };

if (mode === 'seed') {
  const created = write(1, first);
  const comment = write(2, { action: 'comment', ticketId: 'G-1', body: 'Original comment' });
  console.log(JSON.stringify({ created, comment }));
} else if (mode === 'read-and-write') {
  const created = write(3, second);
  const closed = write(4, close);
  const detail = service.read({ ticketId: 'G-1' }, caller.authority);
  const history = service.history({ ticketId: 'G-1' });
  const list = service.list({ includeClosed: true });
  const facets = service.facets('label', 'a');
  const linked = write(5, { action: 'link', ticketId: 'G-1', expectedRevision: 2, targetId: 'G-2', targetRevision: 1, kind: 'related' });
  console.log(JSON.stringify({ created, closed, detail, history, list, facets, linked }));
} else {
  throw new Error(`Unknown ticket oracle mode: ${mode}`);
}
service.close();
