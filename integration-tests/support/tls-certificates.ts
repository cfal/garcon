import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { certificateTrust } from '../../common/controller-tls-node.js';
import type { ServerTlsFiles } from '../../server/config.js';

export interface TestCertificate extends ServerTlsFiles {
  cert: string;
  key: string;
  trust: ReturnType<typeof certificateTrust>;
}

export class TlsCertificates {
  #serial = 2;
  private constructor(readonly directory: string) {}

  static async create(): Promise<TlsCertificates> {
    return new TlsCertificates(await mkdtemp(join(homedir(), 'garcon-tls-test-')));
  }

  async selfSigned(name: string, ca = false): Promise<TestCertificate> {
    const directory = join(this.directory, name);
    await mkdir(directory);
    await this.#openssl(directory, [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-sha256', '-nodes', '-days', '2', '-keyout', 'key.pem', '-out', 'cert.pem',
      '-subj', `/CN=synthetic-${name}`, '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext', `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}`,
    ]);
    return this.#read(directory);
  }

  async issued(name: string, issuer: TestCertificate, options: {
    ca?: boolean;
    expired?: boolean;
    subject?: string;
  } = {}): Promise<TestCertificate> {
    const directory = join(this.directory, name);
    await mkdir(directory);
    await this.#openssl(directory, [
      'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', 'key.pem', '-out', 'request.pem', '-subj', options.subject ?? `/CN=synthetic-${name}`,
    ]);
    await writeFile(join(directory, 'extensions.cnf'), [
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      `basicConstraints=critical,CA:${options.ca ? 'TRUE' : 'FALSE'}`,
      `keyUsage=critical,${options.ca ? 'keyCertSign,cRLSign' : 'digitalSignature'}`,
      'extendedKeyUsage=serverAuth',
    ].join('\n'));
    await this.#openssl(directory, [
      'x509', '-req', '-in', 'request.pem', '-out', 'cert.pem',
      '-CA', issuer.certificatePath, '-CAkey', issuer.keyPath,
      '-set_serial', String(this.#serial++), '-days', options.expired ? '-1' : '2', '-sha256', '-extfile', 'extensions.cnf',
    ]);
    return this.#read(directory);
  }

  async chain(name: string, leaf: TestCertificate, issuers: readonly TestCertificate[]): Promise<TestCertificate> {
    const cert = [leaf, ...issuers].map((certificate) => certificate.cert).join('');
    const certificatePath = join(this.directory, `${name}.pem`);
    await writeFile(certificatePath, cert);
    return { ...leaf, cert, certificatePath, trust: certificateTrust(cert) };
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  async #read(directory: string): Promise<TestCertificate> {
    const certificatePath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    const cert = await readFile(certificatePath, 'utf8');
    return { certificatePath, keyPath, cert, key: await readFile(keyPath, 'utf8'), trust: certificateTrust(cert) };
  }

  async #openssl(directory: string, args: string[]): Promise<void> {
    const process = Bun.spawn(['openssl', ...args], { cwd: directory, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const [exitCode, diagnostic] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(`Synthetic TLS fixture generation failed: ${diagnostic}`);
  }
}
