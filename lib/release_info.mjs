import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function readCommit() {
  const valid = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
  if (valid(process.env.RELEASE_SHA)) return process.env.RELEASE_SHA.toLowerCase();
  try {
    const root = new URL('..', import.meta.url);
    if (!existsSync(new URL('.git', root))) {
      const bundled = JSON.parse(readFileSync(new URL('release.json', root), 'utf8')).commit;
      return valid(bundled) ? bundled.toLowerCase() : null;
    }
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
    }).trim();
    return valid(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const releaseInfo = Object.freeze({
  commit: readCommit(),
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
});
