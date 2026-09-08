export class AgentStartCompensatedError extends Error {
  constructor(cause: unknown) {
    super('Delegated start failed and its creation was fully compensated', { cause });
    this.name = 'AgentStartCompensatedError';
  }
}
