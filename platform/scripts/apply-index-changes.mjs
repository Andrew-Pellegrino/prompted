#!/usr/bin/env node
// Applies a weekly "Prompted Index changes" file (written by the Monday Index task to Drive)
// to index/data.json from main. Usage:
//   node platform/scripts/apply-index-changes.mjs <changes.json> <data.json in> <data.json out>
// The task cannot push to GitHub, so it saves only what changed; this script does the rest and
// validates exactly as the task's STEP 6 does. It refuses a changes file built on a different base.
import fs from 'node:fs';

const [changesPath, inPath, outPath] = process.argv.slice(2);
if (!changesPath || !inPath || !outPath) {
  console.error('usage: apply-index-changes.mjs <changes.json> <data.json in> <data.json out>');
  process.exit(2);
}
const raw = fs.readFileSync(inPath, 'utf8');
const d = JSON.parse(raw);
const c = JSON.parse(fs.readFileSync(changesPath, 'utf8').replace(/^﻿/, ''));
const fail = (m) => { console.error('REFUSED: ' + m); process.exit(1); };

if (c.format !== 'prompted-index-changes-1') fail('unknown format ' + c.format);
if (c.baseUpdated !== d.updated || c.baseIssuesTracked !== d.issuesTracked) {
  fail(`changes were built on updated=${c.baseUpdated}, issuesTracked=${c.baseIssuesTracked}; ` +
    `this data.json has updated=${d.updated}, issuesTracked=${d.issuesTracked}`);
}
const byId = new Map(d.terms.map((t) => [t.id, t]));
const num = (s) => parseInt(s.slice(1), 10);
const pad = (p, n) => p + String(n).padStart(3, '0');

// 1. Issues, oldest first: counts for existing terms and the registry entry.
let maxNo = Math.max(0, ...d.ingestedIssues.map((x) => x.issueNumber || 0));
for (const iss of c.issues || []) {
  if (d.ingestedIssues.some((x) => x.fileId === iss.fileId)) fail('issue already ingested: ' + iss.week);
  for (const [id, n] of Object.entries(iss.termMentions || {})) {
    const t = byId.get(id);
    if (!t) fail('unknown term ' + id);
    if (!Number.isInteger(n) || n < 1) fail('bad mention count for ' + id);
    t.issues += 1;
    t.mentions += n;
  }
  d.issuesTracked += 1;
  d.throughIssue = iss.week;
  maxNo += 1;
  d.ingestedIssues.push({ week: iss.week, title: iss.title, fileId: iss.fileId, status: 'INDEXED', issueNumber: maxNo,
    processedAt: iss.processedAt, result: iss.result, existingTermsChanged: Object.keys(iss.termMentions || {}).length > 0,
    newCandidates: (c.pendingAdd || []).length > 0, humanReviewRequired: (c.pendingAdd || []).length > 0 });
}

// 2. Owner approvals.
let nextT = Math.max(...d.terms.map((t) => num(t.id))) + 1;
let nextD = Math.max(...d.destinations.map((x) => num(x.id))) + 1;
const decided = new Set();
for (const a of c.approved || []) {
  for (const k of ['term', 'anchor', 'surfaces', 'issues', 'mentions', 'def', 'plain', 'why']) if (a[k] == null) fail(`approved ${a.term}: missing ${k}`);
  const id = pad('T', nextT++);
  let dest;
  if (a.map) {
    dest = d.destinations.find((x) => x.id === a.map);
    if (!dest) fail(`approved ${a.term}: no destination ${a.map}`);
    dest.sections.push({ id: a.anchor, title: a.term, def: a.def, plain: a.plain, why: a.why });
    dest.anchors.push(a.anchor);
    dest.related.push(id);
  } else {
    if (!a.title) fail(`approved ${a.term}: new destination needs a title`);
    const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    dest = { id: pad('D', nextD++), title: a.title, slug, def: a.def, plain: a.plain, why: a.why, sections: [],
      anchors: [a.anchor], primary: a.anchor, treatment: 'already-at-top', related: [id] };
    d.destinations.push(dest);
  }
  const surfaceReview = Object.fromEntries(a.surfaces.map((s) => [s, 'editorial']));
  d.terms.push({ id, term: a.term, issues: a.issues, mentions: a.mentions, dest: dest.id, anchor: a.anchor, surfaces: a.surfaces, surfaceReview });
  decided.add(a.queueName || a.term);
}
for (const r of c.rejected || []) decided.add(r);
const pendingBefore = new Set(d.pendingReview.map((p) => p.term));
for (const name of decided) if (!pendingBefore.has(name)) fail('decision for an item that is not pending: ' + name);
d.pendingReview = d.pendingReview.filter((p) => !decided.has(p.term));

// 3. New candidates.
for (const p of c.pendingAdd || []) {
  if (!d.pendingReview.some((x) => x.term === p.term)) d.pendingReview.push({ term: p.term, firstSeen: p.firstSeen, status: 'PENDING' });
}
d.updated = c.updated;

// 4. Validation (the task's STEP 6, plus slug and registry checks).
const errs = [];
const destIds = new Set(d.destinations.map((x) => x.id));
const seen = new Set();
const BAD = new Set(['settings', 'sidebar', 'customize', 'upgrade', 'downloads']);
for (const t of d.terms) {
  if (!destIds.has(t.dest)) errs.push('dest missing ' + t.id);
  if (seen.has(t.anchor)) errs.push('duplicate anchor ' + t.anchor);
  seen.add(t.anchor);
  if (!/^[a-z0-9-]+$/.test(t.anchor) || BAD.has(t.anchor) || t.anchor.startsWith('comment-')) errs.push('bad anchor ' + t.anchor);
  if (t.issues > d.issuesTracked) errs.push('issues > tracked ' + t.id);
  const dest = d.destinations.find((x) => x.id === t.dest);
  if (dest && !dest.anchors.includes(t.anchor)) errs.push('anchor not on destination ' + t.id);
}
for (const x of d.destinations) if (!x.def || !x.plain || !x.why) errs.push('destination incomplete ' + x.id);
const slugs = d.destinations.map((x) => x.slug);
if (new Set(slugs).size !== slugs.length) errs.push('duplicate slug');
if (new Set(d.ingestedIssues.map((x) => x.fileId)).size !== d.ingestedIssues.length) errs.push('issue ingested twice');
if (!/^\d{4}-\d{2}-\d{2}$/.test(d.updated || '')) errs.push('bad updated date');
if (errs.length) fail('validation: ' + errs.join('; '));

fs.writeFileSync(outPath, JSON.stringify(d) + (raw.endsWith('\n') ? '\n' : ''));
console.log(JSON.stringify({ issuesTracked: d.issuesTracked, throughIssue: d.throughIssue, updated: d.updated,
  terms: d.terms.length, destinations: d.destinations.length, pending: d.pendingReview.length }));
