// Fast block dispatcher for markdown-render-speed-02.
//
// Same tokens as marked 18.1.3, faster. Marked's block loop tries
// every block tokenizer's regex on the remaining source, in order.
// This dispatcher looks at the first line instead and only calls a
// tokenizer when that line can start its block. Every tokenizer it
// calls is marked's own, so the tokens it builds are marked's
// tokens, including the merges into a preceding paragraph or text
// token. Anything unexpected throws and parse.js falls back to a
// whole-document marked.parse.
//
// The order of attempts is marked's: space, indented code, fences,
// heading, thematic break, blockquote, list, HTML, link definition,
// table, setext heading, paragraph (only at the top level), text.
import { fastList } from './list.js';

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// Leading spaces, without a cap: four or more means indented code.
function leadSpaces(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

// Leading spaces capped at three: block starts allow at most
// three, and the gates below read from this offset instead of
// slicing the line.
function leadOff(line) {
  let n = 0;
  while (n < 3 && line[n] === ' ') n++;
  return n;
}

function isFencesLine(line, off) {
  return line.startsWith('```', off) || line.startsWith('~~~', off);
}

function isHeadingLine(line, off) {
  let i = off;
  let n = 0;
  while (i < line.length && line[i] === '#' && n < 6) {
    i++;
    n++;
  }
  if (n === 0 || line[i] === '#') return false;
  return i >= line.length || line[i] === ' ' || line[i] === '\t';
}

function isHrLine(line, off) {
  const mark = line[off];
  if (mark !== '-' && mark !== '_' && mark !== '*') return false;
  let i = off;
  let groups = 0;
  while (i < line.length && line[i] === mark) {
    groups++;
    i++;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  }
  return groups >= 3 && i === line.length;
}

function isBlockquoteLine(line, off) {
  return line[off] === '>';
}

// A list marker: a bullet or a 1-9 digit ordered marker, followed
// by a space or tab (or the end of the line). With needSpace only a
// plain space counts, which is the condition that interrupts a
// paragraph or a setext heading's text.
function listMarker(line, needSpace) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  let j;
  if (ch === '*' || ch === '+' || ch === '-') {
    j = i + 1;
  } else if (ch >= '0' && ch <= '9') {
    j = i;
    let digits = 0;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && digits < 9) {
      j++;
      digits++;
    }
    if (digits === 0) return false;
    if (line[j] !== '.' && line[j] !== ')') return false;
    j++;
  } else {
    return false;
  }
  if (needSpace) return line[j] === ' ';
  return j >= line.length || line[j] === ' ' || line[j] === '\t';
}

function isIndentedCodeLine(line) {
  const lead = leadSpaces(line);
  return lead >= 4 || line[lead] === '\t';
}

// A setext underline: one run of = or of -, after at most three
// spaces, then only spaces or tabs to the end of the line.
function isUnderlineLine(line, off) {
  const mark = line[off];
  if (mark !== '=' && mark !== '-') return false;
  let i = off;
  while (i < line.length && line[i] === mark) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length && i > off;
}

// A table delimiter line: only :, |, - and spaces or tabs, and it
// must contain a -. The tokenizer still decides whether it is a
// real delimiter; this is only the gate that says "try table".
function isDelimiterLine(line, off) {
  let i = off;
  let hasDash = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '-') hasDash = true;
    else if (c !== ':' && c !== '|' && c !== ' ' && c !== '\t') return false;
    i++;
  }
  return hasDash;
}

// A line that is only one HTML tag. Marked's setext and paragraph
// rules stop their text before such a line.
function isTagOnlyLine(line, off) {
  if (line[off] !== '<') return false;
  if (line[line.length - 1] !== '>') return false;
  return line.indexOf('>', off + 1) === line.length - 1;
}

// Look at the lines after the first one and decide whether this
// block is a table, a setext heading, or neither. A table needs the
// delimiter on the second line. A setext heading's text can run
// over several lines, so the underline may be further down, but a
// blank line, a delimiter line past the second, or the start of
// another block stops the text first.
function scanSetext(e, firstNl) {
  if (firstNl === -1) return 'none';
  let pos = firstNl + 1;
  let lineNo = 2;
  while (pos < e.length) {
    let end = e.indexOf('\n', pos);
    if (end === -1) end = e.length;
    const line = e.slice(pos, end);
    const off = leadOff(line);
    if (isBlank(line)) return 'none';
    if (isUnderlineLine(line, off)) return 'lheading';
    if (isDelimiterLine(line, off)) return lineNo === 2 ? 'table' : 'none';
    if (
      isHeadingLine(line, off) ||
      isFencesLine(line, off) ||
      isHrLine(line, off) ||
      isBlockquoteLine(line, off) ||
      listMarker(line, true) ||
      isIndentedCodeLine(line) ||
      isTagOnlyLine(line, off)
    ) return 'none';
    pos = end + 1;
    lineNo++;
  }
  return 'none';
}

export function fastBlockTokens(lx, e, t = [], n = false) {
  const tz = lx.tokenizer;
  let smallest = Infinity;
  while (e.length > 0) {
    if (e.length < smallest) smallest = e.length;
    else {
      lx.infiniteLoopError(e.charCodeAt(0));
      break;
    }
    const nl = e.indexOf('\n');
    const first = nl === -1 ? e : e.slice(0, nl);
    const off = leadOff(first);
    const prev = t.at(-1);
    let r = null;

    if (isBlank(first)) {
      r = tz.space(e);
      if (r) {
        e = e.slice(r.raw.length);
        if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else t.push(r);
        continue;
      }
    }

    if (isIndentedCodeLine(first)) {
      r = tz.code(e);
      if (r) {
        e = e.slice(r.raw.length);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          lx.inlineQueue.at(-1).src = prev.text;
        } else t.push(r);
        continue;
      }
    }

    if (isFencesLine(first, off)) {
      r = tz.fences(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (isHeadingLine(first, off)) {
      r = tz.heading(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (isHrLine(first, off)) {
      r = tz.hr(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (isBlockquoteLine(first, off)) {
      r = tz.blockquote(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (listMarker(first, false)) {
      r = fastList(lx, e) ?? tz.list(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (first[off] === '<') {
      r = tz.html(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (first[off] === '[') {
      r = tz.def(e);
      if (r) {
        e = e.slice(r.raw.length);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.raw;
          lx.inlineQueue.at(-1).src = prev.text;
        } else {
          lx.tokens.links[r.tag] || (lx.tokens.links[r.tag] = { href: r.href, title: r.title });
          t.push(r);
        }
        continue;
      }
    }

    const scan = scanSetext(e, nl);
    if (scan === 'table') {
      r = tz.table(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
      r = tz.lheading(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    } else if (scan === 'lheading') {
      r = tz.lheading(e);
      if (r) {
        e = e.slice(r.raw.length);
        t.push(r);
        continue;
      }
    }

    if (lx.state.top) {
      r = tz.paragraph(e);
      if (r) {
        e = e.slice(r.raw.length);
        if (n && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          lx.inlineQueue.pop();
          lx.inlineQueue.at(-1).src = prev.text;
        } else t.push(r);
        n = false;
        continue;
      }
    }

    r = tz.text(e);
    if (r) {
      e = e.slice(r.raw.length);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        lx.inlineQueue.pop();
        lx.inlineQueue.at(-1).src = prev.text;
      } else t.push(r);
      continue;
    }

    lx.infiniteLoopError(e.charCodeAt(0));
    break;
  }
  lx.state.top = true;
  return t;
}
