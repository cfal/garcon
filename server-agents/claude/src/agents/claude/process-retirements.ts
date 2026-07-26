interface ProcessRetirementGroup {
  readonly chatId: string;
  readonly retirements: Set<Promise<void>>;
}

export class ClaudeProcessRetirementTracker {
  readonly #retirements = new Map<string, ProcessRetirementGroup>();

  track(
    agentSessionId: string,
    chatId: string,
    retirement: Promise<void>,
  ): void {
    let group = this.#retirements.get(agentSessionId);
    if (!group) {
      group = { chatId, retirements: new Set() };
      this.#retirements.set(agentSessionId, group);
    } else if (group.chatId !== chatId) {
      throw new Error('Chat ID mismatch');
    }
    group.retirements.add(retirement);
    void retirement.then(
      () => this.#forget(agentSessionId, retirement),
      () => undefined,
    );
  }

  async wait(agentSessionId: string, chatId: string): Promise<void> {
    const group = this.#retirements.get(agentSessionId);
    if (!group) return;
    if (group.chatId !== chatId) throw new Error('Chat ID mismatch');
    await Promise.all(group.retirements);
  }

  #forget(agentSessionId: string, retirement: Promise<void>): void {
    const group = this.#retirements.get(agentSessionId);
    if (!group) return;
    group.retirements.delete(retirement);
    if (group.retirements.size === 0) this.#retirements.delete(agentSessionId);
  }
}
