// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Re-implements makefun-site's own dialect byte-for-byte, tuned for CPU time:
//  - front matter is scanned on the raw text (no split/join of the body),
//    and CR normalisation is skipped when the text holds no CR at all;
//  - Markdown renders in one pass over split lines, inline scanned with a
//    regex fast-path for plain runs;
//  - templates are compiled to plain JavaScript functions (new Function),
//    with the tree-walking interpreter kept as a fallback, so a layout
//    renders without per-node dispatch on every page;
//  - word counts, long dates and tag slugs are cached; each post's card is
//    built once and reused by its page.
// No dependencies, Node stdlib only. No WebAssembly: the rules allow
// JavaScript/TypeScript source only, so the speed comes from fused JS.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Key of a scope's parent link: no valid template path can name it. */
const PSYM = '\0parent';

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7f]/;
const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. NFKD is the identity on pure ASCII, which holds no combining marks.
 */
function slugify(text) {
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) out = slug + '-' + ++n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. Pure: cached. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    const y = date.slice(0, 4);
    const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
    const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
    v = d + ' ' + MONTHS[m - 1] + ' ' + y;
    dateCache.set(date, v);
  }
  return v;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 32 || (c >= 9 && c <= 13);
    else if (c < 128) ws = false;
    else ws = c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const TAG_BAD = /["[\]]/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function rstripSpTab(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return e === s.length ? s : s.slice(0, e);
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        if (tags[i] === '' || TAG_BAD.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Scanned on the raw
 * text: the body is sliced out, never split and re-joined.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = nl === -1 ? text.length : nl + 1;
  let closeStart = -1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      closeStart = pos;
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = nl + 1;
  let lineNo = 2;
  while (pos < closeStart) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos, closeStart) : text.slice(pos, e);
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length && isKeyChar(line.charCodeAt(k))) k++;
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = rstripSpTab(line.slice(k + 2));
      else return { error: 'line ' + lineNo + ' is not "key: value"' };
      if (KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}
function isSpTab(c) {
  return c === 32 || c === 9;
}
function restSpTab(line, from) {
  for (let i = from; i < line.length; i++) if (!isSpTab(line.charCodeAt(i))) return false;
  return true;
}

/** Fence-open language, or null: line is ``` + lang chars + spaces/tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  if (!restSpTab(line, j)) return null;
  return line.slice(3, j);
}
function isFenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restSpTab(line, 3);
}

/** Heading depth + text, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n > 6 || n === line.length || !isSpTab(line.charCodeAt(n))) return null;
  let a = n;
  while (a < line.length && isSpTab(line.charCodeAt(a))) a++;
  let b = line.length;
  while (b > a && isSpTab(line.charCodeAt(b - 1))) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  return restSpTab(line, 3);
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function isWSCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** A list continuation line: two or more spaces then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isWSCode(line.charCodeAt(i));
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SPEC_RE = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    SPEC_RE.lastIndex = i;
    const m = SPEC_RE.exec(s);
    const j = m === null ? -1 : m.index;
    if (j === -1) {
      out += s.slice(i);
      break;
    }
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      const e = s[j + 1];
      out += e === '>' ? '&gt;' : e;
      i = j + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += '<strong>' + inline(s.slice(j + 2, k), env) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += '<em>' + inline(s.slice(j + 1, k), env) + '</em>';
        i = k + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(j + 1, k), env) + '</a>';
        i = m2 + 1;
        continue;
      }
      out += '[';
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      out += '\\';
      i = j + 1;
      continue;
    }
    out += ESCAPES[c];
    i = j + 1;
  }
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
      let code = '';
      for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
      blocks.push('<pre><code' + cls + '>' + code + '</code></pre>');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(kept.join('\n'), env) + '</p>\n</blockquote>');
      continue;
    }
    const c0 = line.charCodeAt(0);
    const c1 = line.charCodeAt(1);
    const bullet = (c0 === 45 || c0 === 42) && c1 === 32;
    let ordered = false;
    let start = 1;
    if (!bullet && c0 >= 48 && c0 <= 57) {
      let j = 1;
      while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j <= 9 && j < line.length && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        ordered = true;
        start = 0;
        for (let k = 0; k < j; k++) start = start * 10 + (line.charCodeAt(k) - 48);
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (ordered) {
          let j = 0;
          while (j < l.length && l.charCodeAt(j) >= 48 && l.charCodeAt(j) <= 57) j++;
          if (j >= 1 && j <= 9 && j < l.length && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) {
            items.push([trimLine(l.slice(j + 2))]);
            i++;
            continue;
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += '<li>' + inline(items[k].join('\n'), env) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function isSpTabOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpTabOnly(src.slice(lineStart, open)) && isSpTabOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s, path[0])) s = s[PSYM];
  if (s === null) return undefined;
  let v = s[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out`, the tree-walking fallback when compiling is unavailable. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') out.push(n.text);
    else if (n.kind === 'var') out.push(escapeHtml(textOf(lookup(scope, n.path))));
    else if (n.kind === 'raw') out.push(textOf(lookup(scope, n.path)));
    else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        const len = xs.length;
        // One scope and one loop record per loop, mutated per element:
        // rendering is synchronous and nothing retains them past the body.
        const sc = { [PSYM]: scope };
        const lp = { length: len };
        for (let k = 0; k < len; k++) {
          sc[n.name] = xs[k];
          sc.loop = lp;
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === len - 1;
          renderNodes(n.body, sc, ctx, depth, out);
        }
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) t(scope, ctx, depth + 1, out);
    }
  }
}

/** JavaScript source for `nodes`, rendered into `out` from scope `sc`. Path arrays are hoisted to the function's top. */
function genNodes(nodes, sc, st) {
  const pref = (path) => '_a' + (st.paths.push(JSON.stringify(path)) - 1);
  let code = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') code += 'out.push(' + JSON.stringify(n.text) + ');';
    else if (n.kind === 'var') code += 'out.push(escapeHtml(textOf(lookup(' + sc + ',' + pref(n.path) + '))));';
    else if (n.kind === 'raw') code += 'out.push(textOf(lookup(' + sc + ',' + pref(n.path) + ')));';
    else if (n.kind === 'if') {
      code += 'if(truthy(lookup(' + sc + ',' + pref(n.path) + '))!==' + (n.not ? 'true' : 'false') + '){' + genNodes(n.then, sc, st) + '}';
      if (n.else !== null) code += 'else{' + genNodes(n.else, sc, st) + '}';
    } else if (n.kind === 'for') {
      const id = st.next++;
      const xs = '_x' + id, k = '_k' + id, len = '_l' + id, sc2 = '_s' + id, lp = '_q' + id;
      code += '{const ' + xs + '=lookup(' + sc + ',' + pref(n.path) + ');if(Array.isArray(' + xs + ')){const ' + len + '=' + xs + '.length;const ' + sc2 + '={' + JSON.stringify(PSYM) + ':' + sc + '};const ' + lp + '={length:' + len + '};for(let ' + k + '=0;' + k + '<' + len + ';' + k + '++){' + sc2 + '[' + JSON.stringify(n.name) + ']=' + xs + '[' + k + '];' + sc2 + '.loop=' + lp + ';' + lp + '.index=' + k + '+1;' + lp + '.first=' + k + '===0;' + lp + '.last=' + k + '===' + len + '-1;' + genNodes(n.body, sc2, st) + '}}}';
    } else if (n.kind === 'include') {
      const id = st.next++;
      const t = '_t' + id;
      code += '{const ' + t + '=ctx.templates.get(' + JSON.stringify(n.name) + ');if(' + t + '!==undefined&&depth<8)' + t + '(' + sc + ',ctx,depth+1,out);}';
    }
  }
  return code;
}

/**
 * A template's render function `(scope, ctx, depth, out)`: the node tree
 * compiled to JavaScript, or the tree-walking interpreter when the Function
 * constructor is unavailable.
 */
function compileTemplate(nodes) {
  try {
    const st = { next: 0, paths: [] };
    const body = genNodes(nodes, 'scope', st);
    const head = st.paths.length === 0 ? '' : 'const ' + st.paths.map((p, i) => '_a' + i + '=' + p).join(',') + ';';
    const fn = new Function('scope', 'ctx', 'depth', 'out', 'escapeHtml', 'textOf', 'truthy', 'lookup', head + body);
    return (scope, ctx, depth, out) => fn(scope, ctx, depth, out, escapeHtml, textOf, truthy, lookup);
  } catch (e) {
    return (scope, ctx, depth, out) => renderNodes(nodes, scope, ctx, depth, out);
  }
}

// ---------------------------------------------------------------- build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = b.input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const c = f.content;
      b.sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = b.base + '/' + s.outDir + '/';
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set();
  for (let i = 0; i < b.statics.length; i++) staticPaths.add(b.statics[i].path);
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return b.bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return b.base + '/' + path + frag;
        b.broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = [];
  for (let i = 0; i < b.sources.length; i++) if (b.sources[i].post) posts.push(b.sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

/** A source's tags, each slug once, in its own order (slugs cached per build). */
function ownTagNames(s, tagSlug) {
  const tags = s.data.tags !== undefined ? s.data.tags : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tags.length; i++) {
    const slug = tagSlug(tags[i]);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(tags[i]);
    }
  }
  return out;
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const slugCache = new Map();
  const tagSlug = (name) => {
    let s = slugCache.get(name);
    if (s === undefined) {
      s = slugify(name);
      slugCache.set(name, s);
    }
    return s;
  };
  const bySlug = new Map();
  for (let pi = 0; pi < b.posts.length; pi++) {
    const p = b.posts[pi];
    p.tagRefs = [];
    const names = ownTagNames(p, tagSlug);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const slug = tagSlug(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: b.base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    if (s.post) continue;
    const names = ownTagNames(s, tagSlug);
    s.tagRefs = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const slug = tagSlug(name);
      const t = bySlug.get(slug);
      s.tagRefs.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. The word count is cached on the source. */
function cardOf(s) {
  if (s.words === undefined) s.words = wordsOf(s.body);
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it; a post reuses its card, built once. */
function pageOf(s) {
  const c = s.post ? s.card : cardOf(s);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
    older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  const cards = new Map();
  for (let i = 0; i < b.posts.length; i++) {
    const c = cardOf(b.posts[i]);
    cards.set(b.posts[i], c);
    b.posts[i].card = c;
  }
  b.cards = cards;
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => cards.get(p));
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ [PSYM]: null, site, tags: allTags, recent, ...vars }, ctx, 0, out);
    return out.join('');
  };
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    b.output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? b.base + '/' : b.base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let ti = 0; ti < b.tags.length; ti++) {
    const t = b.tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) b.output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < b.statics.length; i++) {
    const f = b.statics[i];
    if (Object.hasOwn(b.output, f.path)) b.report.push('shadowed ' + f.path + ': a built page has its path');
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pages = 0;
  for (let i = 0; i < b.sources.length; i++) if (!b.sources[i].post) pages++;
  lines.push('built ' + pages + ' pages, ' + b.posts.length + ' posts, ' + b.tags.length + ' tags and ' + b.statics.length + ' static files');
  b.output[REPORT_FILE] = lines.join('\n') + '\n';
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const reportLines = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    try {
      templates.set(names[i], compileTemplate(parseTemplate(names[i], input.templates[names[i]])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
