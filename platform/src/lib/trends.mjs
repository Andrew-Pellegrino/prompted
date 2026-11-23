// Patterns across every issue: which Index terms show up far more often in recent issues than in the first ones.
// Counting is mechanical (no editorial judgment), so it skips single everyday words that the newsletter also uses
// in their ordinary sense ("the board approved", "staff training"). Each Index entry appears at most once.
import { blocksText } from './issue-model.mjs';

const EVERYDAY = new Set(['approve', 'approved', 'approval', 'approvals', 'approving', 'contain', 'contained', 'containing', 'containment',
  'serve', 'served', 'serving', 'training', 'trained', 'train', 'reasoning', 'reason', 'monitoring', 'monitor', 'logging', 'logs', 'log',
  'permission', 'permissions', 'access', 'deploy', 'deployed', 'deploying', 'deployment', 'release', 'released', 'compute', 'weights',
  'model', 'models', 'token', 'tokens', 'safety', 'alignment', 'evaluation', 'evaluations', 'agent', 'scale', 'scaling', 'inference']);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function risingTerms(issues, indexData, { n = 6, minLate = 5 } = {}) {
  if (!indexData?.terms?.length || issues.length < 9) return null;
  const texts = issues.map((i) => blocksText(i.blocks));
  const k = Math.floor(issues.length / 3);
  const rows = indexData.terms.map((t) => {
    const phr = [...new Set([t.term, ...(t.surfaces || [])].map((s) => s.toLowerCase().trim()))].filter((s) => s && !EVERYDAY.has(s));
    if (!phr.length) return null;
    const res = phr.map((s) => new RegExp(`(?<![A-Za-z0-9])${escRe(s)}(?![A-Za-z0-9])`, 'i'));
    const seen = texts.map((x) => res.some((r) => r.test(x)));
    const early = seen.slice(0, k).filter(Boolean).length, late = seen.slice(-k).filter(Boolean).length;
    return { term: t.term, anchor: t.anchor, dest: t.dest, early, late, k, seen, total: seen.filter(Boolean).length };
  }).filter((r) => r && r.late >= minLate && r.late > r.early);
  rows.sort((a, b) => (b.late - b.early) - (a.late - a.early) || b.late - a.late || a.term.localeCompare(b.term));
  const out = [], dests = new Set();
  for (const r of rows) { if (dests.has(r.dest)) continue; dests.add(r.dest); out.push(r); if (out.length === n) break; }
  return { k, issues: issues.length, terms: out };
}
