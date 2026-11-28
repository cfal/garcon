// A module that reports the Bun it runs on, for the recorder's test.
export function runtime(): unknown[] {
  return [Bun.version, Bun.which('bun')];
}
