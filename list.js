// Fast list parsing for markdown-render-speed-02.
//
// Same list tokens as marked 18.1.3, faster. Marked's list
// tokenizer walks every line of every item testing six block-start
// regexes on it (bullet, thematic break, fences, heading, HTML,
// blockquote). This port follows the same walk, but each of those
// tests is a cheap check on the line's first characters instead of
// a regex, and the tab expansion only runs when a line actually
// starts with whitespace. The item texts, the loose detection and
// the task checkboxes are built exactly the way marked builds them.
// Anything this port does not recognise falls back to marked's own
// list tokenizer, called by the block dispatcher.

// Expand tabs to spaces, the way marked's tab helper does: a tab
// jumps to the next multiple of four columns from base.
function expandTabs(s, base = 0) {
  let col = base;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Replace a line's leading spaces and tabs with their expansion.
function expandLead(line, base = 0) {
  const m = /^[ \t]+/.exec(line);
  if (!m) return line;
  return expandTabs(m[0], base) + line.slice(m[0].length);
}

// Does this line, on its own, form a thematic break of one mark?
function isHrRun(s, mark) {
  let i = 0;
  let groups = 0;
  while (i < s.length && s[i] === mark) {
    groups++;
    i++;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  }
  return groups >= 3 && i === s.length;
}

// Does this line start a block, in the sense of the six tests
// marked's list walk runs on each item line? R is the item's
// indent: at most R-1 leading spaces are allowed before the start.
// With bullets off, only fences, heading, HTML and thematic breaks
// count, which is the test marked runs on an item's first line.
function beginsBlock(line, R, withBullet, lx) {
  const allow = R <= 1 ? 0 : Math.min(3, R - 1);
  let i = 0;
  while (i < allow && line[i] === ' ') i++;
  if (line[i] === ' ') return false;
  const ch = line[i];
  if (ch === undefined) return false;
  if (ch === '`' || ch === '~') {
    return line.startsWith('```', i) || line.startsWith('~~~', i);
  }
  if (ch === '#') {
    let j = i;
    while (j < line.length && line[j] === '#' && j - i < 6) j++;
    if (j - i === 0 || line[j] === '#') return false;
    return j >= line.length || /\s/.test(line[j]);
  }
  if (ch === '>') return withBullet;
  if (ch === '<') {
    return lx.tokenizer.rules.other.htmlBeginRegex(R).test(line);
  }
  if (ch === '*' || ch === '+' || ch === '-') {
    const after = line[i + 1];
    if (withBullet && (after === undefined || after === ' ' || after === '\t')) return true;
    return isHrRun(line.slice(i), ch);
  }
  if (ch === '_') return isHrRun(line.slice(i), ch);
  if (withBullet && ch >= '0' && ch <= '9') {
    let j = i;
    let digits = 0;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && digits < 9) {
      j++;
      digits++;
    }
    if (digits === 0) return false;
    if (line[j] !== '.' && line[j] !== ')') return false;
    const after = line[j + 1];
    return after === undefined || after === ' ' || after === '\t';
  }
  return false;
}

// The first line of a string, without allocating an array.
function firstLineOf(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

export function fastList(lx, e) {
  const tz = lx.tokenizer;
  const rules = tz.rules;
  const other = rules.other;
  const first = rules.block.list.exec(e);
  if (!first) return null;
  const whole = e;
  let rest = e;
  const consumed = () => whole.length - rest.length;
  const marker = first[1].trim();
  const ordered = marker.length > 1;
  const out = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const pattern = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = other.listItemRegex(pattern);
  let sawDoubleBlank = false;

  while (rest.length > 0) {
    const itemMatch = itemRe.exec(rest);
    if (!itemMatch || rules.block.hr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(itemMatch[0].length);
    const firstLine = firstLineOf(itemMatch[2]);
    const bulletWidth = itemMatch[1].length;
    let content = expandLead(firstLine, bulletWidth);
    let nextLine = firstLineOf(rest);
    let prevBlank = !content.trim();
    let indent;
    let text;
    if (prevBlank) {
      indent = bulletWidth + 1;
      text = '';
    } else {
      indent = content.search(other.nonSpaceChar);
      if (indent > 4) indent = 1;
      text = content.slice(indent);
      indent += bulletWidth;
    }
    let blankEaten = false;
    if (prevBlank && other.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      blankEaten = true;
    }
    if (!blankEaten) {
      for (;;) {
        if (rest.length === 0) break;
        const line = firstLineOf(rest);
        nextLine = line;
        const expanded = expandLead(line);
        if (beginsBlock(line, indent, true, lx)) break;
        if (expanded.search(other.nonSpaceChar) >= indent || !line.trim()) {
          text += '\n' + expanded.slice(indent);
        } else {
          if (
            prevBlank ||
            content.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4 ||
            beginsBlock(content, 0, false, lx)
          ) break;
          let piece = line;
          if (
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            rules.block.lheading.test(content + '\n' + line)
          ) {
            piece = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          text += '\n' + piece;
        }
        prevBlank = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const rawItem = whole.slice(itemStart, consumed());
    if (!out.loose) {
      if (sawDoubleBlank) out.loose = true;
      else if (other.doubleBlankLine.test(rawItem)) sawDoubleBlank = true;
    }
    out.items.push({
      type: 'list_item',
      raw: rawItem,
      task: !!other.listIsTask.test(text),
      loose: false,
      text,
      tokens: [],
    });
  }

  const last = out.items.at(-1);
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  out.raw = whole.slice(0, consumed()).trimEnd();

  for (const item of out.items) {
    lx.state.top = false;
    item.tokens = lx.blockTokens(item.text, []);
    if (!out.loose) {
      const spaces = item.tokens.filter((g) => g.type === 'space');
      out.loose =
        spaces.length > 0 && spaces.some((g) => other.anyLine.test(g.raw));
    }
  }

  for (const item of out.items) {
    const head = item.tokens[0];
    if (item.task && (head?.type === 'text' || head?.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      head.raw = head.raw.replace(other.listReplaceTask, '');
      head.text = head.text.replace(other.listReplaceTask, '');
      for (let g = lx.inlineQueue.length - 1; g >= 0; g--) {
        if (other.listIsTask.test(lx.inlineQueue[g].src)) {
          lx.inlineQueue[g].src = lx.inlineQueue[g].src.replace(
            other.listReplaceTask,
            '',
          );
          break;
        }
      }
      const box = other.listTaskCheckbox.exec(item.raw);
      if (box) {
        const check = {
          type: 'checkbox',
          raw: box[0] + ' ',
          checked: box[0] !== '[ ]',
        };
        item.checked = check.checked;
        if (out.loose) {
          const top = item.tokens[0];
          if (
            top &&
            ['paragraph', 'text'].includes(top.type) &&
            'tokens' in top &&
            top.tokens
          ) {
            top.raw = check.raw + top.raw;
            top.text = check.raw + top.text;
            top.tokens.unshift(check);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: check.raw,
              text: check.raw,
              tokens: [check],
            });
          }
        } else {
          item.tokens.unshift(check);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (out.loose) {
    for (const item of out.items) {
      item.loose = true;
      for (const tk of item.tokens) {
        if (tk.type === 'text') tk.type = 'paragraph';
      }
    }
  }
  return out;
}
