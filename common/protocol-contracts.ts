import { isRecord } from './json.js';

export interface ContractRef {
  readonly name: string;
  readonly version: number;
}

export interface ContractDefinition extends ContractRef {
  readonly requires: readonly ContractRef[];
}

export type ContractVersions = Readonly<Record<string, readonly number[]>>;

export interface ProtocolOffer {
  readonly bootstrap: number;
  readonly contracts: ContractVersions;
}

export interface ProtocolProfile extends ProtocolOffer {}

export type ProtocolSelection =
  | { readonly ok: true; readonly profile: ProtocolProfile }
  | { readonly ok: false; readonly code: 'BOOTSTRAP_MISMATCH' };

export function isContractVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function isContractName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][A-Za-z0-9.-]{0,63}$/.test(value);
}

export function isContractRef(value: unknown): value is ContractRef {
  return isRecord(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, 'name') && isContractName(value.name)
    && Object.hasOwn(value, 'version') && isContractVersion(value.version);
}

export function isContractVersions(value: unknown): value is ContractVersions {
  return isRecord(value) && Object.keys(value).length <= 512
    && Object.entries(value).every(([name, versions]) => isContractName(name)
      && Array.isArray(versions) && versions.length >= 1 && versions.length <= 4
      && versions.every(isContractVersion) && new Set(versions).size === versions.length);
}

export function isProtocolOffer(value: unknown): value is ProtocolOffer {
  return isRecord(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, 'bootstrap') && isContractVersion(value.bootstrap)
    && Object.hasOwn(value, 'contracts') && isContractVersions(value.contracts);
}

export function intersectContracts(local: ContractVersions, peer: ContractVersions): ContractVersions {
  const entries: [string, readonly number[]][] = [];
  for (const name of Object.keys(local).sort()) {
    if (!Object.hasOwn(peer, name)) continue;
    const versions = local[name]!.filter(version => peer[name]!.includes(version)).sort((a, b) => a - b);
    if (versions.length) entries.push([name, Object.freeze(versions)]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function selectProtocol(local: ProtocolOffer, peer: ProtocolOffer): ProtocolSelection {
  if (local.bootstrap !== peer.bootstrap) return { ok: false, code: 'BOOTSTRAP_MISMATCH' };
  return { ok: true, profile: Object.freeze({ bootstrap: local.bootstrap,
    contracts: intersectContracts(local.contracts, peer.contracts) }) };
}

export function canonicalProfile(profile: ProtocolProfile): string {
  return JSON.stringify([profile.bootstrap, Object.keys(profile.contracts).sort()
    .map(name => [name, [...profile.contracts[name]!].sort((a, b) => a - b)])]);
}

export function supportsContract(contracts: ContractVersions, required: ContractRef): boolean {
  return Object.hasOwn(contracts, required.name) && contracts[required.name]!.includes(required.version);
}

export function supportsAll(contracts: ContractVersions, required: readonly ContractRef[]): boolean {
  return required.every(contract => supportsContract(contracts, contract));
}

export function supportsDefinition(contracts: ContractVersions, definition: ContractDefinition): boolean {
  return supportsContract(contracts, definition) && supportsAll(contracts, definition.requires);
}

export function contractKey(contract: ContractRef): string {
  return `${contract.name}@${contract.version}`;
}

export function assertDefinitions(definitions: readonly ContractDefinition[]): void {
  const registered = new Map<string, ContractDefinition>();
  for (const definition of definitions) {
    const key = contractKey(definition);
    if (!isContractName(definition.name) || !isContractVersion(definition.version) || registered.has(key)) {
      throw new Error(`Invalid or duplicate contract definition: ${key}`);
    }
    registered.set(key, definition);
  }
  for (const definition of definitions) {
    const required = new Set([contractKey(definition), ...definition.requires.map(contractKey)]);
    for (const ref of definition.requires) {
      const dependency = registered.get(contractKey(ref));
      if (!dependency || dependency.requires.some(item => !required.has(contractKey(item)))) {
        throw new Error(`Incomplete flat requirements: ${contractKey(definition)}`);
      }
    }
  }
}

export function assertOfferComplete(contracts: ContractVersions, definitions: readonly ContractDefinition[]): void {
  const registered = new Map(definitions.map(definition => [contractKey(definition), definition]));
  for (const [name, versions] of Object.entries(contracts)) {
    for (const version of versions) {
      const definition = registered.get(contractKey({ name, version }));
      if (!definition || !supportsDefinition(contracts, definition)) throw new Error(`Incomplete contract offer: ${name}@${version}`);
    }
  }
}

export function contractOffer(definitions: readonly ContractDefinition[]): ContractVersions {
  assertDefinitions(definitions);
  const entries = new Map<string, number[]>();
  for (const definition of definitions) {
    const versions = entries.get(definition.name) ?? [];
    versions.push(definition.version);
    entries.set(definition.name, versions);
  }
  const contracts = Object.freeze(Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, versions]) => [name, Object.freeze(versions.sort((a, b) => a - b))])));
  if (!isContractVersions(contracts)) throw new Error('Contract offer exceeds protocol bounds');
  assertOfferComplete(contracts, definitions);
  return contracts;
}

export function defineContract<const N extends string, const V extends number>(
  name: N, version: V, requires: readonly ContractRef[],
): Readonly<{ name: N; version: V; requires: readonly ContractRef[] }> {
  return Object.freeze({ name, version, requires: Object.freeze(requires.map(ref => Object.freeze({ ...ref }))) });
}
