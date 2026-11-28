// A module whose results differ from one call to the next.
export function roll(): number {
  return Math.random();
}

export function label(sides: number): string {
  return `d${sides}`;
}
