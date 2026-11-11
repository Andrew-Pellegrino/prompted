// Canonical issue model. One approved issue file feeds both the web page and the email.
//
// Block types:
//   paragraph { children:[run], role?: 'opening'|'closing'|'signoff', align?: 'center' }
//   heading   { level: 2|3, children:[run] }        2 = major section, 3 = story subheading
//   list      { ordered: bool, items: [[run]] }
//   quote     { children:[run] }
//   image     { src, alt }
//   divider   {}
// Inline run: { text, bold?, italic?, underline?, href? }
// Renderers never rewrite text; they only wrap runs in markup.

export const SECTION_ORDER = ['The Biggest Developments', 'Worth Knowing Briefly', 'Patterns Worth Watching', 'Why This Week Matters'];
export const CLOSING_LINE = 'That’s the week. See you next Monday.';
export const SIGNOFF_LINE = '— Prompted';

export const runsText = (runs) => runs.map((r) => r.text).join('');
export const blockText = (b) =>
  b.type === 'list' ? b.items.map(runsText).join('\n') : b.children ? runsText(b.children) : '';
/** Stable plain text of an issue body; used for content hashes and fidelity checks. */
export const blocksText = (blocks) => blocks.map(blockText).filter(Boolean).join('\n\n');

const fail = (issue, msg) => { throw new Error(`Invalid issue ${issue?.slug || '(no slug)'}: ${msg}`); };

function checkRuns(issue, runs, where) {
  if (!Array.isArray(runs) || !runs.length) fail(issue, `${where} has no text runs`);
  for (const r of runs) {
    if (typeof r.text !== 'string' || !r.text.length) fail(issue, `${where} has an empty run`);
    for (const k of Object.keys(r)) if (!['text', 'bold', 'italic', 'underline', 'href'].includes(k)) fail(issue, `${where} has unknown run key "${k}"`);
    if (r.href !== undefined && !/^(https?:\/\/|mailto:|\/|#)/.test(r.href)) fail(issue, `${where} has a link with an unsupported URL "${r.href}"`);
  }
}

/** Structural validation. Throws on anything the renderers cannot represent faithfully. */
export function validateIssue(issue) {
  if (issue.schema !== 'prompted-issue-1') fail(issue, 'unknown schema');
  if (!/^[a-z0-9-]+$/.test(issue.slug || '')) fail(issue, 'bad slug');
  for (const k of ['label', 'start', 'end', 'nominal_send_date']) if (!issue.week?.[k]) fail(issue, `week.${k} missing`);
  if (!Array.isArray(issue.blocks) || !issue.blocks.length) fail(issue, 'no blocks');
  issue.blocks.forEach((b, i) => {
    const where = `block ${i} (${b.type})`;
    switch (b.type) {
      case 'paragraph': case 'quote': checkRuns(issue, b.children, where); break;
      case 'heading': if (![2, 3].includes(b.level)) fail(issue, `${where} has level ${b.level}`); checkRuns(issue, b.children, where); break;
      case 'list': if (!b.items?.length) fail(issue, `${where} is empty`); b.items.forEach((it) => checkRuns(issue, it, where)); break;
      case 'image': if (!/^https:\/\//.test(b.src || '')) fail(issue, `${where} needs an https src`); if (typeof b.alt !== 'string') fail(issue, `${where} needs alt text`); break;
      case 'divider': break;
      default: fail(issue, `${where}: unknown block type`);
    }
  });
  return issue;
}

/** Split blocks into sections by level-2 headings (for navigation and QA). */
export function sections(issue) {
  const out = [{ title: null, blocks: [] }];
  for (const b of issue.blocks) {
    if (b.type === 'heading' && b.level === 2) out.push({ title: runsText(b.children).trim(), blocks: [] });
    else out.at(-1).blocks.push(b);
  }
  return out;
}

export const wordCount = (issue) => blocksText(issue.blocks).split(/\s+/).filter(Boolean).length;
export const readMinutes = (issue) => Math.max(1, Math.round(wordCount(issue) / 230));
