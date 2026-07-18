export class BoundedLog<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('BoundedLog capacity must be a positive integer');
    }
    this.#capacity = capacity;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.#capacity) {
      this.#items.splice(0, this.#items.length - this.#capacity);
    }
  }

  values(): readonly T[] {
    return this.#items.slice();
  }
}

