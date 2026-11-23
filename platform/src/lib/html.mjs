// Tiny HTML helpers shared by the web and email renderers.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Render inline runs. Text is escaped and otherwise untouched.
 * opts.link(href, run) may return extra attributes or a rewritten href for <a>.
 */
export function renderRuns(runs, opts = {}) {
  return runs.map((r) => {
    let h = esc(r.text).replace(/\n/g, '<br>');
    if (r.underline) h = `<u>${h}</u>`;
    if (r.italic) h = `<em>${h}</em>`;
    if (r.bold) h = `<strong>${h}</strong>`;
    if (r.href !== undefined) {
      const l = opts.link ? opts.link(r.href, r) : {};
      const attrs = Object.entries({ href: l.href ?? r.href, ...(l.attrs || {}) }).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
      h = `<a ${attrs}>${h}</a>`;
    }
    return h;
  }).join('');
}

export const slugify = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** Links in approved issues that point at the Index's original GitHub Pages address are sent to this site's copy
 *  of the same page (same anchor). Only the address changes; the linked words never do. */
const GITHUB_INDEX = /^https?:\/\/andrew-pellegrino\.github\.io\/prompted\/index\/?/i;
export const localIndexHref = (href, indexUrl) => (indexUrl && GITHUB_INDEX.test(href) ? href.replace(GITHUB_INDEX, indexUrl) : href);

