// Where the build and QA read the Prompted Index from.
//
// The live Index is index/data.json on `main` (production), written every Monday. This development branch
// keeps an older copy in index/ that must not be edited here, so a copy built from it would link to terms
// that are no longer current. With INDEX_SOURCE=main (set by `npm run build` and `npm run qa`) the data is
// read from origin/main after a fetch; if git or the network is unavailable it falls back to the branch
// copy and says so. Tests leave INDEX_SOURCE unset and always use the branch copy, so they stay repeatable.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export async function readIndexData(repoRoot, env = process.env) {
  if (env.INDEX_SOURCE === 'main') {
    try {
      try { execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore', timeout: 30000 }); } catch { /* offline: use the last fetched main */ }
      const text = execFileSync('git', ['show', 'origin/main:index/data.json'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const data = JSON.parse(text);
      return { data, source: `origin/main (updated ${data.updated}, ${data.terms?.length ?? 0} terms)` };
    } catch (e) {
      console.warn(`Could not read the Index from origin/main (${String(e.message).split('\n')[0]}); using this branch's copy.`);
    }
  }
  try {
    const data = JSON.parse(await readFile(path.join(repoRoot, 'index', 'data.json'), 'utf8'));
    return { data, source: `branch copy (updated ${data.updated}, ${data.terms?.length ?? 0} terms)` };
  } catch {
    return { data: null, source: 'none' };
  }
}
