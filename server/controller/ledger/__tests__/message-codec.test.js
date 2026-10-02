import { expect, it } from 'bun:test';
import { decodeLedgerRow } from '../codec.js';

it('rejects invalid provider rows rather than accepting inherited parser members', () => {
  for (const message of [null, [], 42, ...['constructor', 'toString', '__proto__', 'unknown-type'].map(type => ({ type }))]) {
    expect(() => decodeLedgerRow({
      view_id: 'view-1', ordinal: 1, kind: 'provider-row', at: '2026-01-01T00:00:00.000Z',
      client_message_id: null, payload_json: JSON.stringify({ providerMeta: null, value: message }),
    })).toThrow();
  }
});
