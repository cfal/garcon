import { describe, expect, test } from 'bun:test';
import {
  parseControllerOrigin, parseExecutionNodePairing, parseNodeEnrollmentBundle,
  parseNodeEnrollmentIssueRequest, parseNodeEnrollmentRequest, parseNodeEnrollmentResponse, parsePairingSecret,
} from '../execution-node-config.js';

const token = `enroll.enrollment-id.${'A'.repeat(43)}`;
const credential = `node.node-id.${'B'.repeat(42)}A`;
const bundle = () => ({
  version: 1, controllerId: 'controller-id', nodeId: 'node-id', controllerUrl: 'https://controller.example.test',
  trust: { kind: 'system-ca' }, expiresAt: '2026-09-10T12:10:00.000Z', token,
});
const response = () => ({ version: 1, controllerId: 'controller-id', nodeId: 'node-id', credential });

describe('node pairing contracts', () => {
  test('accepts HTTPS origins without imposing local-discovery loopback restrictions', () => {
    for (const origin of ['https://controller.example.test', 'https://127.0.0.1:8443', 'https://[::1]:8443']) {
      expect(parseControllerOrigin(origin)).toBe(origin);
      expect(parseControllerOrigin(`${origin}/`)).toBe(origin);
    }
    expect(parseControllerOrigin('https://CONTROLLER.example.test:443/')).toBe('https://controller.example.test');
  });

  test('rejects plaintext, credentials, paths, queries, fragments, whitespace, and ambiguous slashes', () => {
    for (const value of [null, 1, '', 'http://example.test', 'wss://example.test', 'file:///private',
      'https://user:password@example.test', 'https://@example.test', 'https://example.test/path', 'https://example.test?',
      'https://example.test#', 'https://example.test/#fragment', 'https://example.test/%2e%2e',
      ' https://example.test', 'https://example.test\n', 'https://example.test\\@elsewhere.test',
      'https://example.test//', 'https://example.test:99999', `https://${'a'.repeat(2048)}`]) {
      expect(parseControllerOrigin(value)).toBeNull();
    }
  });

  test('requires only the explicit node identity and refuses caller-selected trust or destinations', () => {
    const input = { nodeId: 'node-id' };
    expect(parseNodeEnrollmentIssueRequest(input)).toEqual(input);
    for (const malformed of [null, {}, { ...input, nodeId: '' }, { ...input, controllerUrl: 'http://example.test' },
      { ...input, controllerUrl: bundle().controllerUrl }, { ...input, trust: bundle().trust },
      { ...input, trust: { kind: 'insecure' } }, { ...input, credential }, { ...input, [Symbol('hidden')]: true }]) {
      expect(parseNodeEnrollmentIssueRequest(malformed)).toBeNull();
    }
    for (const key of Object.keys(input)) {
      const missing = { ...input };
      delete missing[key];
      expect(parseNodeEnrollmentIssueRequest(missing)).toBeNull();
    }
  });

  test('strictly parses both enrollment directions and the retained pairing without substituting namespaces', () => {
    const request = { version: 1, controllerId: bundle().controllerId, nodeId: 'node-id', token };
    expect(parseNodeEnrollmentBundle(bundle())).toEqual(bundle());
    expect(parseNodeEnrollmentRequest(request)).toEqual(request);
    expect(parseNodeEnrollmentResponse(response())).toEqual(response());
    const pairing = { ...response(), controllerUrl: bundle().controllerUrl, trust: bundle().trust };
    expect(parseExecutionNodePairing(pairing)).toEqual(pairing);
    expect(parseNodeEnrollmentResponse({ ...response(), nodeId: 'another-node' })).toBeNull();
    for (const [parse, value] of [
      [parseNodeEnrollmentBundle, bundle()], [parseNodeEnrollmentRequest, request],
      [parseNodeEnrollmentResponse, response()], [parseExecutionNodePairing, pairing],
    ]) {
      for (const malformed of [null, [], {}, { ...value, version: 2 }, { ...value, controllerId: '' },
        { ...value, extra: true }, { ...value, [Symbol('hidden')]: true }]) expect(parse(malformed)).toBeNull();
      for (const key of Object.keys(value)) {
        const missing = { ...value };
        delete missing[key];
        expect(parse(missing)).toBeNull();
      }
    }
  });

  test('accepts only canonical 32-byte secrets in the intended credential domain', () => {
    expect(parsePairingSecret(token, 'enroll')).toEqual({ id: 'enrollment-id' });
    expect(parsePairingSecret(credential, 'node')).toEqual({ id: 'node-id' });
    for (const value of [null, credential, token + '=', token + '.extra', token.slice(0, -1),
      token.slice(0, -1) + 'B', `enroll.bad/id.${'A'.repeat(43)}`, `enroll.${'a'.repeat(129)}.${'A'.repeat(43)}`]) {
      expect(parsePairingSecret(value, 'enroll')).toBeNull();
    }
    expect(parseNodeEnrollmentRequest({ version: 1, controllerId: 'controller-id', nodeId: 'node-id', token: credential })).toBeNull();
  });

  test('rejects malformed dates and unsafe trust, and detaches retained certificate arrays', () => {
    for (const expiresAt of ['', 'tomorrow', '2026-02-31T12:00:00.000Z', '2026-09-10', 0]) {
      expect(parseNodeEnrollmentBundle({ ...bundle(), expiresAt })).toBeNull();
    }
    for (const trust of [null, { kind: 'insecure' }, { kind: 'system-ca', rejectUnauthorized: false }]) {
      expect(parseNodeEnrollmentBundle({ ...bundle(), trust })).toBeNull();
    }
    const input = {
      ...bundle(), trust: {
        kind: 'trusted-pem', certificatesPem: ['-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n'],
        certificateSha256: ['a'.repeat(64)],
      },
    };
    const parsed = parseNodeEnrollmentBundle(input);
    input.trust.certificatesPem[0] = 'changed';
    input.trust.certificateSha256[0] = 'changed';
    expect(parsed.trust.certificatesPem[0]).not.toBe('changed');
    expect(parsed.trust.certificateSha256[0]).toBe('a'.repeat(64));
  });
});
