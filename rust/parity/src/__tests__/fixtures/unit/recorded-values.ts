class Child {
  constructor(readonly label: string) {}
}

class Reply {
  readonly optional = undefined;
  readonly #notEnumerable = 'private';
  constructor(readonly nested: Child[]) {}
  get prototypeGetter(): string { return this.#notEnumerable; }
}

export function echo(value: unknown): unknown {
  return value;
}

export function reply(label: string): Reply {
  return new Reply([new Child(label)]);
}

export function classArgument(value: unknown): string {
  return value instanceof Reply ? 'reply' : 'other';
}

export function throwWithInstance(label: string, asError: boolean): never {
  const reply = new Reply([new Child(label)]);
  if (asError) throw Object.assign(new TypeError('invalid reply'), { reply });
  throw reply;
}
