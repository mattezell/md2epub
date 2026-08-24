// Generated cover, so a shelf full of converted documents is distinguishable.
//
// SVG rather than a raster: drawing text into a PNG would need a font
// rasteriser, and SVG is a core EPUB media type. Reading systems that cannot
// render it fall back to the same generic thumbnail you get with no cover at
// all, so the downside is bounded.

import { escapeXml } from './xml.js';

const WIDTH = 1600;
const HEIGHT = 2560;

// Rough advance width for the title face at 1em, used only to decide line
// breaks. Being slightly off costs a little balance, never correctness.
const CHAR_WIDTH = 0.55;

function wrap(text, fontSize, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const perLine = Math.max(6, Math.floor(maxWidth / (fontSize * CHAR_WIDTH)));
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > perLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * @param {{title: string, authors?: string[], date?: string, subtitle?: string}} book
 * @returns {{bytes: Uint8Array, mediaType: string, ext: string}}
 */
export function generateCover({ title, authors = [], date = '', subtitle = '' }) {
  const margin = 140;
  const usable = WIDTH - margin * 2;

  // Long titles step down a size or two rather than overflowing.
  let titleSize = 132;
  let lines = wrap(title, titleSize, usable);
  while (lines.length > 4 && titleSize > 64) {
    titleSize -= 14;
    lines = wrap(title, titleSize, usable);
  }
  lines = lines.slice(0, 6);

  const blockHeight = lines.length * titleSize * 1.22;
  const titleTop = Math.max(HEIGHT * 0.3, HEIGHT * 0.42 - blockHeight / 2);

  const titleSpans = lines
    .map((line, index) => `      <tspan x="${margin}" y="${Math.round(titleTop + index * titleSize * 1.22)}">${escapeXml(line)}</tspan>`)
    .join('\n');

  const bylineY = Math.round(titleTop + blockHeight + 120);
  const byline = authors.length
    ? `  <text x="${margin}" y="${bylineY}" font-family="Georgia, 'Times New Roman', serif" font-size="62" fill="#c9c4ba">${escapeXml(authors.join(', '))}</text>`
    : '';

  const subtitleY = bylineY + (authors.length ? 90 : 0);
  const subtitleText = subtitle
    ? `  <text x="${margin}" y="${subtitleY}" font-family="Georgia, 'Times New Roman', serif" font-size="46" fill="#9b958a">${escapeXml(subtitle.slice(0, 90))}</text>`
    : '';

  const footer = date
    ? `  <text x="${margin}" y="${HEIGHT - margin}" font-family="Georgia, 'Times New Roman', serif" font-size="44" fill="#8a857c">${escapeXml(date)}</text>`
    : '';

  const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#1d1f23" />
  <rect x="${margin}" y="${margin}" width="${WIDTH - margin * 2}" height="${HEIGHT - margin * 2}" fill="none" stroke="#3d4048" stroke-width="6" />
  <rect x="${margin}" y="${Math.round(titleTop - titleSize - 60)}" width="180" height="10" fill="#c07b3a" />
  <text font-family="Georgia, 'Times New Roman', serif" font-size="${titleSize}" fill="#f2efe9">
${titleSpans}
  </text>
${byline}
${subtitleText}
${footer}
</svg>
`;

  return { bytes: new TextEncoder().encode(svg), mediaType: 'image/svg+xml', ext: 'svg' };
}
