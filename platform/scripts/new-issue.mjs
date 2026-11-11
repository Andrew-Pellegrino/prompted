#!/usr/bin/env node
// Turn the approved issue text into content/issues/NNN-slug.json, then run QA.
//   node scripts/new-issue.mjs path/to/approved-issue.md [--write]
// Without --write it only reports what it would create.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importIssueText } from '../src/lib/import-text.mjs';
import { blocksText } from '../src/lib/issue-model.mjs';
import { loadIssues, loadSite } from '../src/build.mjs';
import { runQA } from '../src/lib/qa.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [file, flag] = process.argv.slice(2);
if (!file) { console.error('Usage: node scripts/new-issue.mjs <approved-issue.md> [--write]'); process.exit(2); }
const issues = await loadIssues(), site = await loadSite();
const issue = importIssueText(await readFile(file, 'utf8'), { number: issues.length + 1 });
if (issues.some((i) => i.slug === issue.slug)) { console.error(`An issue for the week of ${issue.week.label} already exists.`); process.exit(1); }
if (issue.week.end <= issues.at(-1).week.end) { console.error(`Week of ${issue.week.label} is not after the latest issue (${issues.at(-1).week.label}).`); process.exit(1); }
issue.source.content_sha256 = createHash('sha256').update(blocksText(issue.blocks)).digest('hex');
const qa = runQA(issue, site, { strict: true });
console.log(`No. ${issue.number}: ${issue.title}\n${qa.stats.words} words; planned send ${qa.stats.send.local} ${qa.stats.send.timeZone}`);
for (const f of qa.findings) console.log(`${f.level === 'error' ? 'BLOCKING' : 'review  '} [${f.code}] ${f.message}`);
const out = path.join(ROOT, 'content', 'issues', `${String(issue.number).padStart(3, '0')}-${issue.slug}.json`);
if (flag === '--write') { await writeFile(out, JSON.stringify(issue, null, 1) + '\n'); console.log('Wrote ' + path.relative(process.cwd(), out)); }
else console.log('Dry run. Add --write to create ' + path.relative(process.cwd(), out));
