// Default reading stylesheet. Deliberately conservative: e-ink readers ignore
// most layout, so this sets rhythm and code/table handling and stays out of the
// way of the reader's own font and margin settings.
export const DEFAULT_CSS = `@charset "utf-8";

html { font-size: 100%; }

body {
  margin: 0 5%;
  line-height: 1.5;
  text-align: left;
  widows: 2;
  orphans: 2;
}

h1, h2, h3, h4, h5, h6 {
  line-height: 1.2;
  margin: 1.4em 0 0.6em;
  page-break-after: avoid;
  break-after: avoid;
}

h1 { font-size: 1.7em; margin-top: 0; }
h2 { font-size: 1.35em; }
h3 { font-size: 1.15em; }
h4, h5, h6 { font-size: 1em; }

p { margin: 0 0 0.9em; }

a { color: inherit; }

blockquote {
  margin: 1em 1.5em;
  padding-left: 0.8em;
  border-left: 3px solid #999;
  font-style: italic;
}

ul, ol { margin: 0 0 0.9em 1.4em; padding: 0; }
li { margin-bottom: 0.3em; }

pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 0.85em;
  line-height: 1.35;
  margin: 1em 0;
  padding: 0.6em 0.8em;
  border: 1px solid #ccc;
  border-radius: 3px;
  background: #f6f6f6;
}

code, kbd, samp { font-family: monospace; font-size: 0.9em; }
pre code { font-size: 1em; background: transparent; padding: 0; border: 0; }
p code, li code, td code {
  padding: 0.05em 0.25em;
  background: #f0f0f0;
  border-radius: 3px;
}

table {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
  font-size: 0.9em;
}
th, td { border: 1px solid #bbb; padding: 0.35em 0.5em; text-align: left; vertical-align: top; }
th { background: #eee; }

img { max-width: 100%; height: auto; }

figure { margin: 1em 0; text-align: center; }

.md2epub-diagram {
  margin: 1.2em 0;
  page-break-inside: avoid;
  break-inside: avoid;
}

.md2epub-diagram img { max-width: 100%; height: auto; }
figcaption { font-size: 0.85em; font-style: italic; }

hr { border: 0; border-top: 1px solid #bbb; margin: 1.6em 0; }

sup, sub { line-height: 0; font-size: 0.75em; }

.md2epub-cover { margin: 0; padding: 0; text-align: center; }
.md2epub-cover img { max-width: 100%; max-height: 100%; }
`;
