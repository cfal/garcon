import { X509Certificate, createHash } from 'node:crypto';
import {
  MAX_CERTIFICATE_BUNDLE_BYTES,
  MAX_TRUSTED_CERTIFICATES,
  parseControllerTlsTrust,
  type ControllerTlsTrust,
} from './controller-tls.js';

export function certificateTrust(bundle: string): Extract<ControllerTlsTrust, { kind: 'trusted-pem' }> {
  if (Buffer.byteLength(bundle) > MAX_CERTIFICATE_BUNDLE_BYTES) throw new Error('TLS certificate bundle is too large');
  const certificatePattern = /-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
  const certificatesPem = [...bundle.matchAll(certificatePattern)].map(([pem]) => `${pem}\n`);
  if (bundle.replace(certificatePattern, '').trim()) throw new Error('TLS bundle must contain only certificates');
  if (certificatesPem.length < 1 || certificatesPem.length > MAX_TRUSTED_CERTIFICATES) {
    throw new Error(`TLS bundle must contain 1 to ${MAX_TRUSTED_CERTIFICATES} certificates; supply only the private trust chain, not a system CA bundle`);
  }
  const certificateSha256 = certificatesPem.map(certificateDigest);
  const trust = parseControllerTlsTrust({ kind: 'trusted-pem', certificatesPem, certificateSha256 });
  if (!trust || trust.kind !== 'trusted-pem') throw new Error('Invalid TLS certificate bundle');
  return trust;
}

export function verifyControllerTlsTrust(value: ControllerTlsTrust): ControllerTlsTrust {
  const trust = parseControllerTlsTrust(value);
  if (!trust) throw new Error('Invalid controller TLS trust');
  if (trust.kind === 'trusted-pem') {
    for (const [index, pem] of trust.certificatesPem.entries()) {
      if (certificateDigest(pem) !== trust.certificateSha256[index]) {
        throw new Error('Controller certificate fingerprint does not match the trust bundle');
      }
    }
  }
  return trust;
}

function certificateDigest(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}
