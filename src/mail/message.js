// The body of a "here is your book" email. Runtime agnostic so the API, the
// CLI and the Worker all send the same message.

/**
 * @param {{metadata: object, filename: string, bytes: Uint8Array, chapterCount: number, documentCount?: number, warnings: string[]}} result
 * @param {{note?: string, subject?: string}} [extras]
 * @returns {{subject: string, text: string, attachments: Array}}
 */
export function composeBookEmail(result, extras = {}) {
  const lines = [`"${result.metadata.title}" is attached as an EPUB.`, ''];
  if (result.documentCount > 1) lines.push(`Documents: ${result.documentCount}`);
  lines.push(`Chapters: ${result.chapterCount}`);
  lines.push(`Size: ${(result.bytes.length / 1024).toFixed(1)} KB`);

  const note = String(extras.note || '').trim();
  if (note) lines.push('', note);
  if (result.warnings.length) lines.push('', 'Conversion notes:', ...result.warnings.map((w) => `- ${w}`));
  lines.push('', 'Converted from Markdown by md2epub.');

  return {
    subject: String(extras.subject || '').trim() || `EPUB: ${result.metadata.title}`,
    text: lines.join('\n'),
    attachments: [{ filename: result.filename, content: result.bytes, contentType: 'application/epub+zip' }],
  };
}
