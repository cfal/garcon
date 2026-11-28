import * as limits from "../../../../server/remote/transport/limits.js";
import { MessageQueueBudget } from "../../../../server/remote/transport/message-queue-budget.js";

export function transportLimits() {
  return { ...limits };
}

export function queueBudget() {
  const budget = new MessageQueueBudget({
    bytes: 1000, messages: 8, bulkBytes: 600, bulkMessages: 4, controlBytes: 200, controlMessages: 2,
  });
  const bulk = budget.reserve("bulk", 600);
  const primary = budget.reserve("primary", 200);
  const control = budget.reserveControl(100);
  const second = budget.reserveControl(100);
  const full = [budget.canAdmit("bulk", 1), budget.canAdmit("primary", 1), budget.canAdmitControl(1)];
  const counts = [budget.queuedBytes, budget.queuedMessages];
  bulk();
  bulk();
  const freed = [budget.canAdmit("bulk", 1), budget.canAdmit("primary", 1), budget.canAdmitControl(0)];
  primary();
  control();
  second();
  return { full, counts, freed, final: budget.snapshot() };
}
