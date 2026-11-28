let sequence = 0;

export async function createClientChatIds(observations: (number | null)[]): Promise<string[]> {
  const { createClientChatId } = await import("../../../../common/client-chat-id.ts?sample=" + sequence++);
  const priorPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  const priorNow = Date.now;
  Date.now = () => 1783725900000;
  try {
    return observations.map((ms) => {
      Object.defineProperty(globalThis, "performance", {
        value: ms === null ? undefined : { timeOrigin: 0, now: () => ms },
        configurable: true,
      });
      return createClientChatId();
    });
  } finally {
    Date.now = priorNow;
    if (priorPerformance) Object.defineProperty(globalThis, "performance", priorPerformance);
    else Reflect.deleteProperty(globalThis, "performance");
  }
}
