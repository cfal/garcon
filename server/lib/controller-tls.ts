import { X509Certificate, createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import {
  MAX_CERTIFICATE_BUNDLE_BYTES,
  type ControllerTlsTrust,
} from '@garcon/common/controller-tls';
import { certificateTrust } from '@garcon/common/controller-tls-node';
import type { ServerTlsFiles } from '../config.js';

export interface ServerTlsMaterial {
  readonly listener: { readonly cert: string; readonly key: string };
  readonly trust: ControllerTlsTrust;
}

export async function loadServerTls(files: ServerTlsFiles | null): Promise<ServerTlsMaterial | null> {
  if (!files) return null;
  const [cert, key] = await Promise.all([
    readBoundedPem(files.certificatePath),
    readBoundedPem(files.keyPath),
  ]);
  const chain = certificateTrust(cert);
  const leaf = new X509Certificate(cert);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error('TLS certificate and key do not match');
  createSecureContext({ cert, key });
  let trust: ControllerTlsTrust;
  if (files.caPath) {
    trust = certificateTrust(await readBoundedPem(files.caPath));
    if (!trust.certificatesPem.some((pem) => isSelfSigned(new X509Certificate(pem)))) {
      throw new Error('--tls-ca must include a self-signed trust anchor; signed leaf or intermediate certificates alone cannot establish CLI trust');
    }
  } else {
    trust = isSelfSigned(leaf) ? certificateTrust(chain.certificatesPem[0]!) : { kind: 'system-ca' };
  }
  return { listener: { cert, key }, trust };
}

function isSelfSigned(certificate: X509Certificate): boolean {
  return certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey);
}

async function readBoundedPem(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_CERTIFICATE_BUNDLE_BYTES) {
      throw new Error('TLS material must be a bounded regular file');
    }
    const buffer = Buffer.alloc(MAX_CERTIFICATE_BUNDLE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CERTIFICATE_BUNDLE_BYTES) throw new Error('TLS material is too large');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}
