import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const valid = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

function sourceCommit() {
  if (valid(process.env.RELEASE_SHA)) return process.env.RELEASE_SHA.toLowerCase();
  try {
    if (existsSync(join(root, '.git'))) {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
      }).trim();
      if (valid(sha)) return sha.toLowerCase();
    }
  } catch {}
  try {
    const sha = readFileSync(join(root, 'release-source.txt'), 'utf8').trim();
    if (valid(sha)) return sha.toLowerCase();
  } catch {}
  try {
    const bundled = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).commit;
    if (valid(bundled)) return bundled.toLowerCase();
  } catch {}
  return null;
}

function fingerprint() {
  const hash = createHash('sha256');
  const extensions = /\.(?:mjs|js|json|css|html|svg|png|jpg|jpeg|webp|ico|woff2)$/i;
  function hashSource(relative) {
    const filename = join(root, relative);
    if (statSync(filename).isDirectory()) {
      for (const entry of readdirSync(filename, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!entry.name.startsWith('.') && (entry.isDirectory() || (entry.isFile() && extensions.test(entry.name)))) {
          hashSource(relative + '/' + entry.name);
        }
      }
      return;
    }
    hash.update(relative).update('\0').update(createHash('sha256').update(readFileSync(filename)).digest());
  }
  try {
    for (const source of ['lib', 'public', 'server.mjs', 'package.json']) hashSource(source);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export const releaseInfo = Object.freeze({
  commit: sourceCommit(),
  fingerprint: fingerprint(),
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
});
