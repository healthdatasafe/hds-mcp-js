import path from 'node:path';
import type { DataModelPack } from '../dataModel/pack.ts';
import { localized } from '../dataModel/pack.ts';
import type { Normalized, PkgEvent, Report } from './inspect.ts';

// The review page (site-agents#36 A5): one static HTML file in the package's .hds-import/ folder, opened in the
// person's browser. It holds the values, so they are checked there and not in the chat. No script, no external asset
// (CSP), every text escaped; source pages (PDF / JPEG / PNG only, checked by inspect) shown as images or linked
// (`file.pdf#page=N`). Everything the kit writes is shown: value, duration, description, file, extra clientData.

const EXAMPLES_PER_ITEM = 3;

export function escapeHtml (s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** A URL to a package file from .hds-import/review.html, each path segment encoded. */
function fileUrl (rel: string): string {
  return '../' + rel.split(/[\\/]/).filter((p) => p !== '' && p !== '.').map(encodeURIComponent).join('/');
}

function streamNames (pack: DataModelPack, lang: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: any[]) => { for (const s of list ?? []) { out.set(s.id, s.label ? localized(s.label, lang) : (s.name ?? s.id)); walk(s.children ?? []); } };
  walk(pack.streams ?? []);
  return out;
}

function itemName (pack: DataModelPack, e: PkgEvent, lang: string): string {
  const item = e.itemKey ? pack.items[e.itemKey] : null;
  return item?.label ? localized(item.label as Record<string, string>, lang) : (e.itemKey ?? e.type);
}

/** The date and time in this computer's time zone (the person's), as the person reads it. */
function dateText (time: number, lang: string): string {
  try {
    return new Date(time * 1000).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return 'invalid date';
  }
}

function durationText (seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 3 * 86400) return `${Math.round(seconds / 360) / 10} h`;
  return `${Math.round(seconds / 8640) / 10} days`;
}

/** The value as written, a linked record shown as such. */
function valueText (content: unknown): string {
  if (content == null) return '';
  if (typeof content !== 'object') return String(content);
  return JSON.stringify(content, (_k, v) => (v != null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$ref === 'string') ? '(linked record)' : v, 1);
}

function evidenceHtml (e: PkgEvent): string {
  if (!e.evidence) return '';
  const url = fileUrl(e.evidence.file) + (!e.evidence.image && e.evidence.page != null ? `#page=${e.evidence.page}` : '');
  if (e.evidence.image) return `<a href="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="source page" loading="lazy"></a>`;
  return `<a href="${escapeHtml(url)}">source${e.evidence.page != null ? `, page ${e.evidence.page}` : ''}</a>`;
}

function groupBy<T> (list: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    const arr = out.get(k);
    if (arr) arr.push(x);
    else out.set(k, [x]);
  }
  return out;
}

export function renderReview (pack: DataModelPack, report: Report, n: Normalized, { lang = 'en' }: { lang?: string } = {}): string {
  if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(lang)) lang = 'en';
  const names = streamNames(pack, lang);
  const byRoot = groupBy(n.events, (e) => e.root ?? '?');
  const problems = report.problems.length === 0
    ? '<p class="ok">No problem found.</p>'
    : '<ul>' + report.problems.map((p) => `<li class="${p.blocking ? 'block' : 'warn'}">${p.line != null ? `line ${p.line}: ` : ''}${escapeHtml(p.code)}${p.detail ? ` (${escapeHtml(p.detail)})` : ''}</li>`).join('') + '</ul>';

  const sections = [...byRoot].sort(([a], [b]) => a.localeCompare(b)).map(([root, events]) => {
    const perItem = groupBy(events, (e) => itemName(pack, e, lang));
    const summary = [...perItem].map(([name, list]) =>
      `<li><b>${escapeHtml(name)}</b>: ${list.length} · e.g. ` +
      list.slice(0, EXAMPLES_PER_ITEM).map((e) => `${escapeHtml(dateText(e.time, lang))} <code>${escapeHtml(valueText(e.content))}</code>`).join('; ') + '</li>'
    ).join('');
    const rows = events.slice().sort((a, b) => a.time - b.time).map((e) => {
      const extra = Object.keys(e.clientData).length > 0 ? `<div class="d">other data: <code>${escapeHtml(JSON.stringify(e.clientData))}</code></div>` : '';
      return `<tr><td>${escapeHtml(dateText(e.time, lang))}${e.duration != null ? `<div class="d">for ${escapeHtml(durationText(e.duration))}</div>` : ''}</td>` +
        `<td>${escapeHtml(itemName(pack, e, lang))}${e.streamIds.length > 1 ? `<div class="d">also in: ${escapeHtml(e.streamIds.slice(1).map((s) => names.get(s) ?? s).join(', '))}</div>` : ''}</td>` +
        `<td><code>${escapeHtml(valueText(e.content))}</code>${e.description ? `<div class="d">${escapeHtml(e.description)}</div>` : ''}` +
        `${e.attachment ? `<div class="d">file: ${escapeHtml(path.basename(e.attachment.rel))}</div>` : ''}${extra}</td>` +
        `<td>${evidenceHtml(e)}</td><td class="l">${e.line}</td></tr>`;
    }).join('');
    return `<section><h2>${escapeHtml(names.get(root) ?? root)} <small>(${events.length})</small></h2><ul>${summary}</ul>` +
      `<details><summary>Every value</summary><table><thead><tr><th>Date</th><th>What</th><th>Value</th><th>Source</th><th>Line</th></tr></thead><tbody>${rows}</tbody></table></details></section>`;
  }).join('');

  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Review before import</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px;color:#1d1d1f;background:#fff}
h1{font-size:1.5em}h2{font-size:1.2em;border-top:1px solid #ddd;padding-top:12px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:4px 6px;vertical-align:top;text-align:left}
code{white-space:pre-wrap;word-break:break-word}.d{color:#555;font-size:.9em}.l{color:#888}
img{max-width:220px;border:1px solid #ccc}.block{color:#b00020}.warn{color:#8a5a00}.ok{color:#1b6e2a}
.note{background:#f4f6f8;padding:10px 12px;border-radius:6px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}td,th{border-color:#333}.d{color:#aaa}.note{background:#222}}
</style></head><body>
<h1>Review before import</h1>
<p class="note">This page is on your computer only. Check the values against your documents, then tell your assistant whether to go ahead.
Nothing has been written to your Health Data Safe account yet. ${report.events} record(s) in ${report.roots.length} kind(s) of data${report.documents ? `, ${report.documents} document(s) with their file` : ''}.
Anyone or any program that can read this file can see these values, including an assistant with browser or screen tools: delete it when you are done (ask your assistant to clean up).</p>
<h2>Problems</h2>${problems}
${sections}
</body></html>
`;
}
