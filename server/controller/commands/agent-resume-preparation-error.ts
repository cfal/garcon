export class AgentResumePreparationError extends Error {
  constructor(cause: unknown) {
    super('Delegated child transcript could not be prepared before admission', { cause });
    this.name = 'AgentResumePreparationError';
  }
}
