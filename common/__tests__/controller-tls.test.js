import { describe, expect, test } from 'bun:test';
import {
  MAX_CERTIFICATE_BUNDLE_BYTES,
  MAX_CERTIFICATE_PEM_BYTES,
  MAX_TRUSTED_CERTIFICATES,
  controllerTlsOptions,
  parseControllerTlsTrust,
} from '../controller-tls.js';

const pem = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n';
const trust = () => ({ kind: 'trusted-pem', certificatesPem: [pem], certificateSha256: ['a'.repeat(64)] });

describe('controller TLS trust contract', () => {
  test('accepts only the two explicit trust policies', () => {
    expect(parseControllerTlsTrust({ kind: 'system-ca' })).toEqual({ kind: 'system-ca' });
    expect(parseControllerTlsTrust(trust())).toEqual(trust());
    for (const value of [null, [], {}, { kind: 'insecure' }, { kind: 'system-ca', rejectUnauthorized: false },
      { ...trust(), insecure: true }, { ...trust(), certificateSha256: [] }]) {
      expect(parseControllerTlsTrust(value)).toBeNull();
    }
  });

  test('rejects malformed PEMs and fingerprints', () => {
    for (const certificate of ['', 'not a certificate', pem + pem, pem + '\u2000', pem.replace('CERTIFICATE', 'PRIVATE KEY')]) {
      expect(parseControllerTlsTrust({ ...trust(), certificatesPem: [certificate] })).toBeNull();
    }
    for (const digest of ['', 'a'.repeat(63), 'G'.repeat(64), 'A'.repeat(64), null]) {
      expect(parseControllerTlsTrust({ ...trust(), certificateSha256: [digest] })).toBeNull();
    }
  });

  test('bounds individual certificates, certificate count, and aggregate bytes', () => {
    expect(parseControllerTlsTrust({
      ...trust(), certificatesPem: [pem + ' '.repeat(MAX_CERTIFICATE_PEM_BYTES)],
    })).toBeNull();
    expect(parseControllerTlsTrust({
      kind: 'trusted-pem', certificatesPem: Array(MAX_TRUSTED_CERTIFICATES + 1).fill(pem),
      certificateSha256: Array(MAX_TRUSTED_CERTIFICATES + 1).fill('a'.repeat(64)),
    })).toBeNull();
    const certificate = pem + ' '.repeat(MAX_CERTIFICATE_PEM_BYTES - pem.length);
    const count = MAX_CERTIFICATE_BUNDLE_BYTES / MAX_CERTIFICATE_PEM_BYTES + 1;
    expect(parseControllerTlsTrust({
      kind: 'trusted-pem', certificatesPem: Array(count).fill(certificate),
      certificateSha256: Array(count).fill('a'.repeat(64)),
    })).toBeNull();
  });

  test('captures owned arrays and never disables verification', () => {
    const input = trust();
    const parsed = parseControllerTlsTrust(input);
    input.certificatesPem[0] = 'changed';
    input.certificateSha256[0] = 'changed';
    expect(parsed).toEqual(trust());
    const options = controllerTlsOptions(parsed);
    expect(options).toEqual({ ca: [pem], rejectUnauthorized: true });
    options.ca[0] = 'changed';
    expect(parsed.certificatesPem).toEqual([pem]);
    expect(controllerTlsOptions({ kind: 'system-ca' })).toEqual({ rejectUnauthorized: true });
  });
});
