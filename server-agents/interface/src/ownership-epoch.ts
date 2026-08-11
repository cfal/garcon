declare const agentOwnershipEpochBrand: unique symbol;

export type AgentOwnershipEpoch = string & {
  readonly [agentOwnershipEpochBrand]: true;
};

export function agentOwnershipEpoch(value: string): AgentOwnershipEpoch {
  if (!value.trim()) throw new TypeError('Agent ownership epoch is required');
  return value as AgentOwnershipEpoch;
}
