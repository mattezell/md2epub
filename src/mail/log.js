// Dry run mailer: writes the message to disk and logs it instead of sending.
// Used by the test suite and by MAIL_TRANSPORT=log, so the email path can be
// exercised end to end without credentials.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function createLogMailer({ dir = '.mail-outbox', log = console.log } = {}) {
  const outDir = resolve(dir);
  let counter = 0;
  return {
    kind: 'log',
    describe: () => `dry run, messages written to ${outDir}`,
    verify: async () => true,
    async send({ to, subject, text, attachments }) {
      counter += 1;
      await mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(outDir, `${stamp}-${counter}`);
      await writeFile(`${base}.txt`, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);
      for (const attachment of attachments || []) {
        await writeFile(join(outDir, `${stamp}-${counter}-${attachment.filename}`), Buffer.from(attachment.content));
      }
      log(`[md2epub] dry run email to ${to} written to ${base}.txt`);
      return { messageId: `dry-run-${counter}`, accepted: [to], rejected: [] };
    },
  };
}
