// Makes an https certificate the phone can trust, so the app (and its service worker) works
// on the Wi-Fi exactly like it will when hosted. Run: npm run phone:cert
//
// 1. A small certificate authority (CA), created once: tools/certs/ca.key + ca.crt.
//    It is name-constrained to private 192.168.x.x / 10.x.x.x addresses and "localhost", so even
//    if ca.key leaked it could not be used to fake real websites. Keep ca.key on this PC only.
// 2. A server certificate for this PC's current Wi-Fi address(es), signed by that CA
//    (tools/certs/server.key + server.crt). Run again if the router gives the PC a new address.
//
// The phone installs ca.crt once (served at /lan-ca.crt by `npm run phone`). Remove it from the
// phone when you no longer need it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'certs');
mkdirSync(dir, { recursive: true });
const f = (name) => join(dir, name);

const candidates = ['openssl', 'C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe'];
const openssl = candidates.find((c) => {
  try {
    execFileSync(c, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!openssl) throw new Error('OpenSSL not found (it comes with Git for Windows)');
const run = (...args) => execFileSync(openssl, args, { stdio: ['ignore', 'ignore', 'inherit'] });

const ips = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a.family === 'IPv4' && !a.internal && /^(192\.168|10)\./.test(a.address))
  .map((a) => a.address);

if (!existsSync(f('ca.key')) || !existsSync(f('ca.crt'))) {
  writeFileSync(
    f('ca.cnf'),
    `[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = Offline Map dev CA (this PC only)
O = Offline Map development
[ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:127.0.0.0/255.0.0.0, permitted;DNS:localhost
`,
  );
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825', '-keyout', f('ca.key'), '-out', f('ca.crt'), '-config', f('ca.cnf'));
  console.log('Created a new local CA: tools/certs/ca.crt (install this on the phone)');
}

const sans = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(', ');
writeFileSync(
  f('server.cnf'),
  `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${ips[0] || 'localhost'}
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${sans}
authorityKeyIdentifier = keyid
`,
);
run('req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', f('server.key'), '-out', f('server.csr'), '-config', f('server.cnf'));
run('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '397', '-sha256', '-extfile', f('server.cnf'), '-extensions', 'ext', '-out', f('server.crt'));
// a DER copy: some Android versions only install CA files in this form
run('x509', '-in', f('ca.crt'), '-outform', 'der', '-out', f('ca.der.crt'));
console.log(`Server certificate for: ${sans}`);
