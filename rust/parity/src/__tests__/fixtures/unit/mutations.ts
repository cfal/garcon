export function mutate(input: { count: number }): number {
  return input.count++;
}

export async function mutateLater(input: { count: number }): Promise<number> {
  await Promise.resolve();
  return input.count++;
}

export class MutatingConstructor {
  readonly before: number;

  constructor(input: { count: number }) {
    this.before = input.count++;
  }
}
