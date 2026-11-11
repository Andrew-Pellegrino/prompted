// Issue -> web article HTML. Same source as the email; wording is never changed.
import { esc, renderRuns, slugify } from './html.mjs';
import { runsText } from './issue-model.mjs';
import { mastheadWeek } from './weeks.mjs';

const link = (href) => (/^https?:\/\//.test(href) ? { attrs: { rel: 'noopener' } } : {});

/** Returns { html, toc } where toc lists major sections and stories with anchor ids. */
export function renderIssueWeb(issue) {
  const used = new Set();
  const toc = [];
  const anchor = (text) => {
    let id = slugify(text) || 'section', n = 2;
    while (used.has(id)) id = `${slugify(text)}-${n++}`;
    used.add(id);
    return id;
  };
  const parts = issue.blocks.map((b) => {
    switch (b.type) {
      case 'heading': {
        const text = runsText(b.children).trim();
        const id = anchor(text);
        toc.push({ level: b.level, text, id });
        return `<h${b.level} id="${id}">${renderRuns(b.children, { link })}</h${b.level}>`;
      }
      case 'paragraph': {
        const cls = [b.role, b.align === 'center' ? 'center' : null].filter(Boolean).join(' ');
        return `<p${cls ? ` class="${cls}"` : ''}>${renderRuns(b.children, { link })}</p>`;
      }
      case 'quote': return `<blockquote><p>${renderRuns(b.children, { link })}</p></blockquote>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        return `<${tag}>${b.items.map((it) => `<li>${renderRuns(it, { link })}</li>`).join('')}</${tag}>`;
      }
      case 'image': return `<figure><img src="${esc(b.src)}" alt="${esc(b.alt)}" loading="lazy"></figure>`;
      case 'divider': return '<hr>';
      default: throw new Error(`render-web: unknown block ${b.type}`);
    }
  });
  return { html: parts.join('\n'), toc };
}

/** The masthead shared by issue pages: live text, no per-week image. */
export function renderMasthead(issue, site, { base = '' } = {}) {
  return `<header class="masthead">
  <img class="lockup" src="${base}/img/miami-altman-lockup.png" width="160" height="127" alt="Miami University, John W. Altman Institute for Entrepreneurship">
  <p class="mast-title">${esc(site.name)}</p>
  <p class="mast-sub">${esc(site.tagline)}</p>
  <p class="mast-week">${esc(mastheadWeek(issue.week))}</p>
  <p class="mast-for">${esc(site.attribution)}</p>
</header>`;
}
