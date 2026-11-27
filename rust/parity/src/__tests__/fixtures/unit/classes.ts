// A module of classes with static methods and private static state.
export class Ticket {
  static #kind = 'ticket';
  static label = 'ticket';

  static parse(text: string): { text: string; kind: string } | null {
    return text ? { text, kind: Ticket.#kind } : null;
  }

  static fail(code: string): never {
    throw new DomainError(`failed ${code}`, code);
  }

  readonly text: string;

  constructor(text: string) {
    if (text === 'throws') throw new RangeError('bad text');
    this.text = text;
  }

  render(): string {
    return Ticket.parse(this.text) ? `T:${this.text}` : 'none';
  }
}

export class DomainError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
    this.name = 'DomainError';
  }
}
