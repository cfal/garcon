// Calls the exports of classes.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { DomainError, Ticket } from './classes.js';

test('calls classes', () => {
  expect(Ticket.label).toBe('ticket');
  expect(Ticket.parse('t')).toEqual({ text: 't', kind: 'ticket' });
  expect(Ticket.parse('')).toBeNull();
  expect(new Ticket('a').render()).toBe('T:a');
  expect(new Ticket('a') instanceof Ticket).toBe(true);
  expect(() => new Ticket('throws')).toThrow(RangeError);
  expect(() => Ticket.fail('E_X')).toThrow(DomainError);
  expect(Ticket.parse('u')).toEqual({ text: 'u', kind: 'ticket' });
});
