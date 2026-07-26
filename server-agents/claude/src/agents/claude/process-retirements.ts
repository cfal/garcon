interface ProcessRetirementGroup {
  readonly chatId: string;
  readonly processExits: Set<Promise<void>>;
}

export class ClaudeProcessRetirementTracker {
  readonly #processExits = new Map<string, ProcessRetirementGroup>();

  track(
    agentSessionId: string,
    chatId: string,
    processExit: Promise<void>,
  ): void {
    let group = this.#processExits.get(agentSessionId);
    if (!group) {
      group = { chatId, processExits: new Set() };
      this.#processExits.set(agentSessionId, group);
    } else if (group.chatId !== chatId) {
      throw new Error('Chat ID mismatch');
    }
    group.processExits.add(processExit);
    void processExit.then(
      () => this.#forget(agentSessionId, processExit),
      // An unobservable exit must remain fail-closed to prevent concurrent writers.
      () => undefined,
    );
  }

  async wait(agentSessionId: string, chatId: string): Promise<void> {
    const group = this.#processExits.get(agentSessionId);
    if (!group) return;
    if (group.chatId !== chatId) throw new Error('Chat ID mismatch');
    await Promise.all(group.processExits);
  }

  #forget(agentSessionId: string, processExit: Promise<void>): void {
    const group = this.#processExits.get(agentSessionId);
    if (!group) return;
    group.processExits.delete(processExit);
    if (group.processExits.size === 0) this.#processExits.delete(agentSessionId);
  }
}
