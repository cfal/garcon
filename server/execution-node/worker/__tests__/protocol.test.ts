import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, parseNodeWorkerChildText, parseNodeWorkerParentText,
  serializeNodeWorkerChild, serializeNodeWorkerParent } from '../protocol.js';
import { configureMessage, manifest, session } from './lifecycle-fixture.js';

test('worker lifecycle controls round-trip exact immutable session, configuration and manifests', () => {
  const configured = configureMessage();
  const parsed = parseNodeWorkerParentText(serializeNodeWorkerParent(configured));
  expect(parsed).toEqual(configured);
  configured.configuration.instances[0]!.environment.SYNTHETIC_KEY = 'replacement';
  expect(parsed).toMatchObject({ configuration: { instances: [{ environment: { SYNTHETIC_KEY: 'synthetic-private-value' } }] } });
  for (const type of ['node-worker-pulse', 'node-worker-attach', 'node-worker-admit', 'node-worker-disconnect'] as const) {
    const message = { type, version: NODE_WIRE_VERSION, session, connectionId: 2 } as const;
    expect(parseNodeWorkerParentText(serializeNodeWorkerParent(message))).toEqual(message);
  }
  for (const role of ['session', 'instance'] as const) {
    const message = { type: 'node-worker-hello', version: NODE_WIRE_VERSION, role, pid: 42 } as const;
    expect(parseNodeWorkerChildText(serializeNodeWorkerChild(message))).toEqual(message);
  }
  const ready = { type: 'node-worker-ready', version: NODE_WIRE_VERSION, session, manifests: [manifest()] } as const;
  expect(parseNodeWorkerChildText(serializeNodeWorkerChild(ready))).toEqual(ready);
});

test('worker parent envelopes reject undeclared fields, sessions, roles, versions and identifiers', () => {
  const configured = configureMessage();
  for (const input of [{ ...configured, version: 2 }, { ...configured, session: { ...session, controllerBootId: '' } },
    { ...configured, connectionId: 0 }, { ...configured, connectionId: 1.5 }, { ...configured, connectionId: Number.MAX_SAFE_INTEGER + 1 },
    { ...configured, secret: 'synthetic-private-value' }, { ...configured, configuration: null },
    { ...configured, configuration: { ...configured.configuration, role: 'controller' } },
    { ...configured, type: 'node-worker-admit' }, { type: 'node-worker-admit', version: 1, session },
  ]) expect(parseNodeWorkerParentText(JSON.stringify(input))).toBeNull();
  expect(parseNodeWorkerParentText('x'.repeat(MAX_NODE_WORKER_LIFECYCLE_BYTES + 1))).toBeNull();
});

test('worker replies cannot claim duplicate instances or manifests from different nodes', () => {
  const ready = { type: 'node-worker-ready', version: NODE_WIRE_VERSION, session, manifests: [manifest()] };
  for (const input of [{ ...ready, manifests: [manifest(), manifest()] },
    { ...ready, manifests: [manifest(), { ...manifest(), instanceId: 'synthetic-other', nodeId: 'foreign-node' }] },
    { ...ready, manifests: [{ ...manifest(), credential: 'synthetic-private-value' }] },
    { ...ready, version: 2 }, { ...ready, session: { ...session, nodeBootId: null } },
    { type: 'node-worker-hello', version: 1, role: 'controller', pid: 42 },
    { type: 'node-worker-hello', version: 1, role: 'session', pid: 0 },
    { type: 'node-worker-hello', version: 1, role: 'session', pid: 42, connectionId: 1 },
  ]) expect(parseNodeWorkerChildText(JSON.stringify(input))).toBeNull();
  expect(parseNodeWorkerChildText('x'.repeat(MAX_NODE_WORKER_LIFECYCLE_BYTES + 1))).toBeNull();
});
