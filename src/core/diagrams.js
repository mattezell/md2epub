import { decodeHTML } from 'entities';

// Diagram blocks become images.
//
// The core does not render anything: it finds the fences, hands each source to
// an injected renderer, and rewrites the fence to an <img>. That keeps the
// browser (which is what mermaid needs) out of the runtime agnostic core, and
// means a fence stays an ordinary code block wherever no renderer is available.

const DEFAULT_LANGUAGES = ['mermaid'];

// Documentation written for a site that renders mermaid in the browser often
// uses a raw <pre class="mermaid"> block rather than a fence, because syntax
// highlighters intercept the fence before mermaid sees it. Both forms are the
// same diagram, so both are rendered.
const PRE_MERMAID = /<pre[^>]*class=["'][^"']*\bmermaid\b[^"']*["'][^>]*>([\s\S]*?)<\/pre>/gi;

/** Every <pre class="mermaid"> block in a chunk of raw HTML, source decoded. */
export function findPreMermaid(html) {
  const found = [];
  PRE_MERMAID.lastIndex = 0;
  let match = PRE_MERMAID.exec(html);
  while (match) {
    const source = decodeHTML(match[1]).trim();
    if (source) found.push({ source, block: match[0] });
    match = PRE_MERMAID.exec(html);
  }
  return found;
}

// FNV-1a, 64 bits as two 32 bit halves. Content addressing only, not security:
// it names the rendered file and keys the on disk cache.
export function hashSource(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

// Mermaid's own frontmatter can name the diagram; a leading %% comment often
// does too. Either makes better alt text than "mermaid diagram".
export function altTextFor(source, language) {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(source);
  if (frontmatter) {
    const title = /^\s*title:\s*(.+?)\s*$/m.exec(frontmatter[1]);
    if (title) return title[1].replace(/^["']|["']$/g, '');
  }
  const comment = /^\s*%%\s*(.+?)\s*$/m.exec(source);
  if (comment && comment[1].length < 120) return comment[1];
  const kind = /^\s*(?:---[\s\S]*?---\s*)?(\w[\w-]*)/.exec(source);
  return `${kind ? kind[1] : language} diagram`;
}

/** Find every renderable diagram in a parsed token stream, in either form. */
export function findDiagrams(tokens, languages = DEFAULT_LANGUAGES) {
  const found = [];
  for (const token of tokens) {
    if (token.type === 'fence') {
      const language = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
      if (!languages.includes(language)) continue;
      if (!token.content.trim()) continue;
      found.push({ language, source: token.content, hash: hashSource(`${language}:${token.content}`) });
    } else if (token.type === 'html_block' && languages.includes('mermaid')) {
      for (const { source } of findPreMermaid(token.content)) {
        found.push({ language: 'mermaid', source, hash: hashSource(`mermaid:${source}`) });
      }
    }
  }
  return found;
}

export const DIAGRAM_DIR = 'diagrams';

export const diagramPath = (hash, ext) => `${DIAGRAM_DIR}/${hash}.${ext}`;
