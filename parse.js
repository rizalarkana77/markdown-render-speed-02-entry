// Fast drop-in for marked 18.1.3 (default options, GFM on).
//
// marked's own Lexer and Parser do the real work. The speed comes
// from two fast paths written for this entry: fastBlockTokens in
// block.js replaces the block loop, and fastInline in inline.js
// replaces the per-token inline loop for each queued inline source.
// Both call marked's own tokenizers, so the tokens and the HTML are
// marked's. If a fast path throws for any reason, the whole
// document falls back to marked.parse, so the result is never
// wrong, only slower.
import { Lexer, Parser, marked } from './vendor/marked/marked.esm.js';
import { fastInline } from './inline.js';
import { fastBlockTokens } from './block.js';

export function parse(markdown) {
  try {
    const src = markdown.replace(/\r\n|\r/g, '\n');
    const lx = new Lexer();
    lx.blockTokens = (e, t = [], n = false) => fastBlockTokens(lx, e, t, n);
    const tokens = fastBlockTokens(lx, src, lx.tokens);
    for (const q of lx.inlineQueue) {
      lx.state.inRawBlock = false;
      fastInline(lx, q.src, q.tokens);
    }
    lx.inlineQueue = [];
    return new Parser().parse(tokens);
  } catch {
    return marked.parse(markdown);
  }
}
