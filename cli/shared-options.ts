// Shared syntax is independent of command-family registration. Each parser still
// validates whether its action accepts an option and how often it may occur.
export const SHARED_PARSE_OPTIONS = {
  label: { type: 'string', multiple: true },
  ready: { type: 'boolean' },
  title: { type: 'string' },
  cwd: { type: 'string' },
} as const;
