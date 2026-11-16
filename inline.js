// Fast inline parsing for markdown-render-speed-02.
//
// Same HTML as marked 18.1.3, faster. Marked's own inline loop tries
// every inline tokenizer's regex at every position. This dispatcher
// looks at the first character instead and only calls a tokenizer
// when that character can start its token. Every tokenizer it calls
// is marked's own, so the tokens it builds are marked's tokens, and
// anything unexpected falls back to marked's inlineTokens, which in
// turn falls back to a whole-document marked.parse in parse.js.
//
// The only work re-implemented here is the cheap gating and the
// masking string that marked's emStrong/del closers read. Masking is
// length preserving, so a masked string stays aligned with the
// source it was built from.

// A backslash escape only fires when the next character is one of
// these punctuation marks. A backslash before a newline is a hard
// break instead, handled by the br gate below.
const ESC_RE = /^[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]$/;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
const TAG_SECOND_RE = /[A-Za-z/?!]/;
const AUTO_SECOND_RE = /[A-Za-z]/;

// A link label is normalised the way marked normalises a reference
// tag: trim, collapse whitespace to one space, lower, upper, lower.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Mirror of marked's Lexer masking step: hide the inside of link
// labels, code spans and raw HTML from the emphasis/delimiter
// closers, replacing characters with 'a' or '+' of the same length
// so the masked string stays aligned with the source.
function maskInline(src, lx) {
  const rules = lx.tokenizer.rules.inline;
  let out = src;
  const hasBracket = src.includes('[');
  const hasTick = src.includes('`');
  const hasBackslash = src.includes('\\');
  const hasTag = src.includes('<');
  if (lx.tokens.links && hasBracket) {
    const search = rules.reflinkSearch;
    const maskRef = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(lx.tokens.links, normLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (lx.linkInText(inner)) {
          return '[' + inner.replace(search, maskRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    out = out.replace(search, maskRef);
  }
  if (hasTick || hasBackslash) {
    out = out.replace(
      rules.anyPunctuationOutsideCode,
      (match, ticks, escaped) =>
        escaped
          ? '+'.repeat(match.length)
          : ticks
            ? ticks + match.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
            : match,
    );
  }
  if (hasBracket || hasTick || hasTag) {
    out = out.replace(rules.blockSkip, (match, _first, second) => {
      const keep = second ? second.length : 0;
      return match.slice(0, keep) + '[' + 'a'.repeat(match.length - keep - 2) + ']';
    });
  }
  return out;
}

// A link or reference link needs an unescaped ] somewhere ahead.
// A ] behind a backslash is part of the label, not its end.
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === ']') return true;
  }
  return false;
}

// A code span needs a later backtick run of exactly the same length
// as the run that opens it. Runs are maximal, so a run of that length
// can only be the closing run.
function codespanPossible(s) {
  let k = 0;
  while (s[k] === '`') k++;
  for (let i = k; i < s.length; i++) {
    if (s[i] !== '`') continue;
    let j = i;
    while (s[j] === '`') j++;
    if (j - i === k) return true;
    i = j - 1;
  }
  return false;
}

// The extended autolink tokenizer only fires for a scheme, www.,
// or an email address at the current position. The checks below
// read characters in place so the common case, plain text, costs
// no allocation at all.
function lower2(s, i) {
  return s.charCodeAt(i) | 32;
}

function maybeUrl(s) {
  const c0 = s.charCodeAt(0);
  if (c0 === 104 || c0 === 72) {
    // http:// or https://, either case
    if (
      lower2(s, 1) === 116 &&
      lower2(s, 2) === 116 &&
      lower2(s, 3) === 112 &&
      (lower2(s, 4) === 115
        ? s.charCodeAt(5) === 58 &&
          s.charCodeAt(6) === 47 &&
          s.charCodeAt(7) === 47
        : s.charCodeAt(4) === 58 &&
          s.charCodeAt(5) === 47 &&
          s.charCodeAt(6) === 47)
    ) return true;
  } else if (c0 === 102 || c0 === 70) {
    // ftp://, either case
    if (
      lower2(s, 1) === 116 &&
      lower2(s, 2) === 112 &&
      s.charCodeAt(3) === 58 &&
      s.charCodeAt(4) === 47 &&
      s.charCodeAt(5) === 47
    ) return true;
  } else if (c0 === 109 || c0 === 77) {
    // mailto:, lower case only in marked's pattern
    if (s.startsWith('ailto:', 1)) return true;
  } else if (c0 === 120 || c0 === 88) {
    // xmpp:, lower case only
    if (s.startsWith('mpp:', 1)) return true;
  } else if (c0 === 119) {
    // www., lower case only
    if (s[1] === 'w' && s[2] === 'w' && s[3] === '.') return true;
  }
  // An email address: local characters, then @, then a domain
  // character. Only the first character decides whether to look.
  if (
    (c0 >= 48 && c0 <= 57) ||
    (c0 >= 65 && c0 <= 90) ||
    (c0 >= 97 && c0 <= 122) ||
    c0 === 46 ||
    c0 === 95 ||
    c0 === 43 ||
    c0 === 45
  ) {
    for (let i = 1; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 64) {
        const d = s.charCodeAt(i + 1);
        return (
          (d >= 48 && d <= 57) ||
          (d >= 65 && d <= 90) ||
          (d >= 97 && d <= 122) ||
          d === 45
        );
      }
      if (
        !(
          (c >= 48 && c <= 57) ||
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          c === 46 ||
          c === 95 ||
          c === 43 ||
          c === 45
        )
      ) return false;
    }
  }
  return false;
}

// Emphasis can only open when the character after the delimiter run
// is present, is not the delimiter itself and is not whitespace:
// otherwise marked's left-delimiter groups are all empty and it
// returns nothing. For an underscore run, an alphanumeric character
// on both sides of the run means intraword, which marked also
// refuses. The character before the run is read from the full
// source, or '' at the start of it.
function emPossible(s, delim, full, off) {
  let k = 0;
  while (s[k] === delim) k++;
  const after = s[k];
  if (after === undefined || after === delim || WS_RE.test(after)) return false;
  if (delim === '_') {
    const before = off === 0 ? '' : full[off - 1];
    if (before !== '' && ALNUM_RE.test(before) && ALNUM_RE.test(after)) return false;
  }
  return true;
}

// Strikethrough can only open for a run of one or two tildes whose
// next character is present, not a tilde and not whitespace. When
// the next character is punctuation, marked also requires the
// previous character to be empty or punctuation, or it refuses.
function delPossible(s, prev, lx) {
  let k = 0;
  while (s[k] === '~') k++;
  if (k > 2) return false;
  const after = s[k];
  if (after === undefined || after === '~' || WS_RE.test(after)) return false;
  if (
    PUNCT_RE.test(after) &&
    prev !== '' &&
    !lx.tokenizer.rules.inline.punctuation.exec(prev)
  ) return false;
  return true;
}

// Closer positions for one masked string, computed once: the last
// index where a run of * or _ (or ~) could close an emphasis (or
// strikethrough) span. Marked computes this once per inline pass
// and caches it; the port below reads it from here instead of
// re-scanning the string on every emphasis attempt.
function closerIndex(masked) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (
      before !== ' ' &&
      before !== '\t' &&
      before !== '\n' &&
      before !== '\r' &&
      before !== '\f'
    ) {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Emphasis and strong emphasis, following marked's own algorithm:
// the left-delimiter groups, the rule of three, and the right
// delimiter scan. The inner text is parsed by marked's
// inlineTokens, as in marked. The only difference from calling
// marked's tokenizer is that the closer positions come from the
// once-computed table above instead of a fresh scan per attempt.
function myEmStrong(e, masked, prev, lx, close) {
  const rules = lx.tokenizer.rules.inline;
  const other = lx.tokenizer.rules.other;
  const ld = rules.emStrongLDelim.exec(e);
  if (!ld || (!ld[1] && !ld[2] && !ld[3] && !ld[4])) return null;
  const delim = ld[0][0];
  const sameAsPrev = prev === delim;
  const i = masked.length - e.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!rules.punctuation.exec(p);
  let n = prev;
  if (l < i) n = p;
  const u = l < i ? h : !!rules.punctuation.exec(n);
  if (ld[4] && n.match(other.unicodeAlphaNumeric)) return null;
  const d = ld[1] || ld[3] || '';
  if (!d || !n || u) {
    const k = [...ld[0]].length - 1;
    const openAnywhere =
      !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const right =
      delim === '*' ? rules.emStrongRDelimAst : rules.emStrongRDelimUnd;
    const v = close.em[delim];
    const q = masked.length - e.length + k;
    if (v < q) return null;
    const t = masked.slice(-e.length + k);
    const last = v - q;
    const y = i - l + k;
    let m = k;
    let f = 0;
    let rd;
    for (
      right.lastIndex = 0;
      (rd = right.exec(t)) !== null && !(rd.index > last);

    ) {
      const g = rd[1] || rd[2] || rd[3] || rd[4] || rd[5] || rd[6];
      if (!g) continue;
      const run = [...g].length;
      if (rd[3] || rd[4]) {
        m += run;
        continue;
      } else if (rd[5] || rd[6] || openAnywhere) {
        if (sameAsPrev && (rd[5] || rd[6])) break;
        if (y % 3 && !((y + run) % 3)) {
          f += run;
          continue;
        }
      }
      m -= run;
      if (m > 0) continue;
      const used = Math.min(run, run + m + f);
      const head = [...rd[0]][0].length;
      const raw = e.slice(0, k + rd.index + head + used);
      if (Math.min(k, used) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: lx.inlineTokens(text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: lx.inlineTokens(text) };
    }
  }
  return null;
}

// Strikethrough, following marked's own algorithm, with the same
// once-computed closer table as emphasis.
function myDel(e, masked, prev, lx, close) {
  const rules = lx.tokenizer.rules.inline;
  const ld = rules.delLDelim.exec(e);
  if (!ld) return null;
  if (!(ld[1] || '') || !prev || rules.punctuation.exec(prev)) {
    const o = [...ld[0]].length - 1;
    const u = close.del;
    const q = masked.length - e.length + o;
    if (u < q) return null;
    const t = masked.slice(-e.length + o);
    const last = u - q;
    const right = rules.delRDelim;
    let p = o;
    let rd;
    for (
      right.lastIndex = 0;
      (rd = right.exec(t)) !== null && !(rd.index > last);

    ) {
      const g = rd[1] || rd[2] || rd[3] || rd[4] || rd[5] || rd[6];
      if (!g) continue;
      let run = [...g].length;
      if (run !== o) continue;
      if (rd[3] || rd[4]) {
        p += run;
        continue;
      }
      p -= run;
      if (p > 0) continue;
      run = Math.min(run, run + p);
      const head = [...rd[0]][0].length;
      const raw = e.slice(0, o + rd.index + head + run);
      const text = raw.slice(o, -o);
      return { type: 'del', raw, text, tokens: lx.inlineTokens(text) };
    }
  }
  return null;
}

// Parse one inline source into tokens, appending to out. On any
// surprise, throw the work away and let marked do it instead.
export function fastInline(lx, src, out) {
  const startLen = out.length;
  const tz = lx.tokenizer;
  const savedParen = lx.state.linkParenPossible;
  const savedInLink = lx.state.inLink;
  const savedInRaw = lx.state.inRawBlock;
  lx.state.linkParenPossible = savedParen && src.includes(')');
  let masked = null;
  let close = null;
  const mask = () => {
    if (masked === null) {
      masked = maskInline(src, lx);
      close = closerIndex(masked);
    }
    return masked;
  };
  try {
    let e = src;
    let prev = '';
    let wasText = false;
    let smallest = Infinity;
    while (e.length > 0) {
      if (e.length < smallest) smallest = e.length;
      else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      if (!wasText) prev = '';
      wasText = false;
      const c = e[0];
      const off = src.length - e.length;
      let tok = null;
      if (c === '\\' && e[1] !== undefined && ESC_RE.test(e[1])) tok = tz.escape(e);
      if (!tok && c === '<' && TAG_SECOND_RE.test(e[1] || '')) tok = tz.tag(e);
      if (
        !tok &&
        (c === '[' || (c === '!' && e[1] === '[')) &&
        hasUnescapedBracket(e)
      ) tok = tz.link(e);
      if (
        !tok &&
        (c === '[' || (c === '!' && e[1] === '[')) &&
        hasUnescapedBracket(e)
      ) {
        tok = tz.reflink(e, lx.tokens.links);
        if (tok) {
          e = e.slice(tok.raw.length);
          if (tok.type === 'text') {
            const last = out[out.length - 1];
            if (last?.type === 'text') {
              last.raw += tok.raw;
              last.text += tok.text;
            } else out.push(tok);
          } else out.push(tok);
          continue;
        }
      }
      if (!tok && (c === '*' || c === '_') && emPossible(e, c, src, off)) {
        mask();
        tok = myEmStrong(e, masked, prev, lx, close);
      }
      if (!tok && c === '`' && codespanPossible(e)) tok = tz.codespan(e);
      if (
        !tok &&
        ((c === ' ' && e[1] === ' ' && /^ {2,}\n/.test(e)) ||
          (c === '\\' && e[1] === '\n'))
      ) tok = tz.br(e);
      if (!tok && c === '~' && delPossible(e, prev, lx)) {
        mask();
        tok = myDel(e, masked, prev, lx, close);
      }
      if (!tok && c === '<' && AUTO_SECOND_RE.test(e[1] || '')) tok = tz.autolink(e);
      if (!tok && !lx.state.inLink && maybeUrl(e)) tok = tz.url(e);
      if (tok) {
        e = e.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      const text = tz.inlineText(e);
      if (!text) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      e = e.slice(text.raw.length);
      if (text.raw.slice(-1) !== '_') prev = text.raw.slice(-1);
      wasText = true;
      const last = out[out.length - 1];
      if (last?.type === 'text') {
        last.raw += text.raw;
        last.text += text.text;
      } else out.push(text);
    }
  } catch {
    out.length = startLen;
    lx.state.inLink = savedInLink;
    lx.state.inRawBlock = savedInRaw;
    lx.inlineTokens(src, out);
  } finally {
    lx.state.linkParenPossible = savedParen;
  }
}
