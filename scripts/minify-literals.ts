// Build-only plugin: squeezes the CSS, GLSL and HTML that ship inside template literals. The JS
// minifier keeps template text byte for byte, so indentation, comments and line breaks in our
// styles and shaders would otherwise ship. Runs on the rendered chunk, so it sees what ships.
import type { Plugin } from 'vite-plus';

type Kind = 'glsl' | 'css' | 'html';

const kindOf = (text: string): Kind | null => {
  if (/#version|precision highp|\buniform\b|void main/.test(text)) return 'glsl';
  if (/^\s*</.test(text)) return 'html';
  if (/[\w\])*-]\s*\{[^{}]*:[^{}]*;/.test(text)) return 'css';
  return null;
};

export const squeeze = (raw: string, kind: Kind): string => {
  if (kind === 'glsl')
    return raw
      .replace(/\/\/[^\n]*/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n\s*/g, '\n')
      .replace(/ ?([,;(){}=*?:]) ?/g, '$1');
  if (kind === 'css')
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/ ?([{};,]) ?/g, '$1')
      .replace(/: /g, ':')
      .replace(/;}/g, '}');
  // HTML collapses runs of whitespace into one space anyway.
  return raw.replace(/\s*\n\s*/g, ' ');
};

interface Node {
  type: string;
  start: number;
  end: number;
  quasis?: { start: number; end: number; value: { raw: string } }[];
  [k: string]: unknown;
}

const walk = (node: unknown, visit: (n: Node) => void): void => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node;
  if (typeof n.type === 'string') visit(n);
  for (const k in n) if (k !== 'type') walk(n[k], visit);
};

export const minifyLiterals = (): Plugin => ({
  name: 'chartroom:minify-literals',
  apply: 'build',
  renderChunk(code) {
    const edits: { start: number; end: number; text: string }[] = [];
    walk(this.parse(code), (n) => {
      if (n.type !== 'TemplateLiteral' || !n.quasis) return;
      const kind = kindOf(n.quasis.map((q) => q.value.raw).join('${}'));
      if (!kind) return;
      for (const q of n.quasis) {
        const at = code.indexOf(q.value.raw, q.start);
        if (at < 0 || at > q.end) continue;
        const text = squeeze(q.value.raw, kind);
        if (text !== q.value.raw) edits.push({ start: at, end: at + q.value.raw.length, text });
      }
    });
    if (edits.length === 0) return null;
    edits.sort((a, b) => b.start - a.start);
    let out = code;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return { code: out, map: null };
  },
});
