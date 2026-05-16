import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import markdown from 'highlight.js/lib/languages/markdown';

/**
 * Tree-shaken `lowlight` wrapper. We register a curated list of languages
 * common in chat — adding new ones is one import + one register call. The
 * full `lowlight/common` bundle is ~3x the size of this hand-picked set.
 *
 * Why lowlight and not highlight.js directly? hljs only exposes an HTML
 * string; rendering that requires `dangerouslySetInnerHTML`, which the
 * markdown layer (see `lib/markdown.ts`) deliberately avoids. lowlight
 * returns a `hast` tree we map to React nodes via `renderHast` below — so
 * the security posture stays "no HTML strings, ever".
 */
const lowlight = createLowlight();

lowlight.register('javascript', javascript);
lowlight.register('js', javascript);
lowlight.register('jsx', javascript);
lowlight.register('typescript', typescript);
lowlight.register('ts', typescript);
lowlight.register('tsx', typescript);
lowlight.register('python', python);
lowlight.register('py', python);
lowlight.register('json', json);
lowlight.register('yaml', yaml);
lowlight.register('yml', yaml);
lowlight.register('bash', bash);
lowlight.register('sh', bash);
lowlight.register('shell', shell);
lowlight.register('css', css);
lowlight.register('html', xml);
lowlight.register('xml', xml);
lowlight.register('sql', sql);
lowlight.register('diff', diff);
lowlight.register('rust', rust);
lowlight.register('rs', rust);
lowlight.register('go', go);
lowlight.register('golang', go);
lowlight.register('java', java);
lowlight.register('markdown', markdown);
lowlight.register('md', markdown);

export interface HastTextNode {
  type: 'text';
  value: string;
}

export interface HastElementNode {
  type: 'element';
  tagName: string;
  properties?: { className?: string | string[] } | undefined;
  children: HastNode[];
}

export type HastNode = HastTextNode | HastElementNode | { type: 'root'; children: HastNode[] };

export function isLanguageSupported(language: string | null | undefined): boolean {
  if (!language) return false;
  return lowlight.registered(language.toLowerCase());
}

/**
 * Highlight a code string for a known language. Returns the hast root the
 * caller renders. If the language isn't registered, returns null and the
 * caller can fall back to plain rendering.
 */
export function highlight(language: string, code: string): HastNode | null {
  const key = language.toLowerCase();
  if (!lowlight.registered(key)) return null;
  try {
    return lowlight.highlight(key, code) as unknown as HastNode;
  } catch {
    return null;
  }
}
