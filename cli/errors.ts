export type CliErrorPhase =
  | 'arguments'
  | 'discovery'
  | 'runtime verification'
  | 'authentication'
  | 'catalog resolution'
  | 'resume admission'
  | 'chat status'
  | 'export'
  | 'submission'
  | 'title update'
  | 'receipt polling'
  | 'transport recovery';

export type CliExitCode = 1 | 2 | 3 | 4 | 130;

export class CliError extends Error {
  constructor(
    readonly phase: CliErrorPhase,
    message: string,
    readonly exitCode: CliExitCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CliError';
  }
}

export function argumentError(message: string, options?: ErrorOptions): CliError {
  return new CliError('arguments', message, 2, options);
}
