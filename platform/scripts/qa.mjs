#!/usr/bin/env node
// Run pre-send QA for one issue (or the latest) from the command line.
//   node scripts/qa.mjs [slug]
import { loadIssues, loadSite } from '../src/build.mjs';
import { runQA } from '../src/lib/qa.mjs';
import { indexAnchors } from '../src/lib/index-terms.mjs';
import { readFile } from 'node:fs/promises';
const issues = await loadIssues(), site = await loadSite();
const issue = process.argv[2] ? issues.find((i) => i.slug === process.argv[2]) : issues.at(-1);
if (!issue) { console.error('No such issue. Known slugs:\n' + issues.map((i) => '  ' + i.slug).join('\n')); process.exit(2); }
let anchors; try { anchors = indexAnchors(JSON.parse(await readFile(new URL('../../index/data.json', import.meta.url), 'utf8'))); } catch { /* Index optional */ }
const qa = runQA(issue, site, { strict: true, indexAnchors: anchors });
console.log(`${issue.title}\n${qa.stats.words} words, ${qa.stats.email_kb} KB email, ${qa.stats.links} links; planned send ${qa.stats.send.local} ${qa.stats.send.timeZone} (${qa.stats.send.utc})`);
for (const f of qa.findings) console.log(`${f.level === 'error' ? 'BLOCKING' : 'review  '} [${f.code}] ${f.message}`);
console.log(qa.ok ? 'QA passed (no blocking problems).' : `QA FAILED: ${qa.errors} blocking problem(s).`);
process.exit(qa.ok ? 0 : 1);
