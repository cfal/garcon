import assert from 'node:assert/strict';
import { supportsContract, type ContractVersions } from '../../common/protocol-contracts.js';
import type { ContractProbe, UnsupportedWorkflow } from './compatibility-contract.js';

export class CompatibilityEvidence {
  readonly checked: string[] = [];
  readonly unsupported: UnsupportedWorkflow[] = [];
  readonly #visited = new Set<string>();

  constructor(readonly contracts: Readonly<Record<ContractProbe['surface'], ContractVersions>>,
    private readonly expected: readonly UnsupportedWorkflow[]) {
    assert.equal(new Set(expected.map(item => item.workflow)).size, expected.length, 'Duplicate unsupported workflow');
    assert(expected.every(item => item.missing.length > 0), 'Unsupported workflows must name missing contracts');
  }

  async check(workflow: string, required: readonly ContractProbe[], run: () => Promise<unknown>,
    verifyRefusal: (missing: readonly ContractProbe[]) => Promise<void>): Promise<void> {
    assert(!this.#visited.has(workflow), `Duplicate workflow: ${workflow}`);
    const missing = required.filter(ref => !supportsContract(this.contracts[ref.surface], ref));
    const expected = this.expected.find(item => item.workflow === workflow)?.missing ?? [];
    const keys = (refs: readonly ContractProbe[]) => refs.map(ref => `${ref.surface}:${ref.name}@${ref.version}`).sort();
    assert.deepEqual(keys(missing), keys(expected), `Unexpected contract availability for ${workflow}`);
    if (missing.length) {
      await verifyRefusal(missing);
      this.unsupported.push({ workflow, missing });
    } else {
      await run();
      this.checked.push(workflow);
    }
    this.#visited.add(workflow);
  }

  report() {
    for (const { workflow } of this.expected) assert(this.#visited.has(workflow), `Unverified unsupported workflow: ${workflow}`);
    return { checked: this.checked, unsupported: this.unsupported, contracts: this.contracts };
  }
}
