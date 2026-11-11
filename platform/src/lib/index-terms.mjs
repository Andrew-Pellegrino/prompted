// Read-only bridge to the Prompted Index (../index/data.json, maintained by its own weekly task).
// Nothing here writes to the Index. Only approved terms with a live destination are linked.
import { blocksText } from './issue-model.mjs';

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function indexAnchors(indexData) {
  const set = new Set();
  for (const t of indexData.terms || []) if (t.anchor) set.add(t.anchor);
  for (const d of indexData.destinations || []) { if (d.slug) set.add(d.slug); for (const s of d.sections || []) if (s.id) set.add(s.id); }
  return set;
}

/**
 * Approved Index terms whose own name appears in the issue text.
 * Matching uses the term name only (not the looser "surfaces" list), whole words,
 * case-sensitive for short or acronym-style names, so ordinary-language uses are not linked.
 */
export function termsInIssue(issue, indexData, limit = 14) {
  const text = blocksText(issue.blocks);
  const dests = new Map((indexData.destinations || []).map((d) => [d.id, d]));
  const hits = [];
  for (const t of indexData.terms || []) {
    if (!t.anchor || !dests.has(t.dest)) continue;
    const strict = t.term.length <= 4 || t.term === t.term.toUpperCase() || !/\s/.test(t.term);
    const re = new RegExp(`(?<![\\w-])${reEsc(t.term)}(?![\\w-])`, strict ? 'g' : 'gi');
    const n = (text.match(re) || []).length;
    if (n) hits.push({ term: t.term, anchor: t.anchor, count: n, issues: t.issues });
  }
  return hits.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, limit);
}
