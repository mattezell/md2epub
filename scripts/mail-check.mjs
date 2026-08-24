#!/usr/bin/env node
// Check the mail configuration before relying on it.
//
//   node scripts/mail-check.mjs                 verify the connection and login
//   node scripts/mail-check.mjs you@example.com also send a real test book
//   node scripts/mail-check.mjs --kindle        send the test book to KINDLE_ADDRESS
//
// Nothing here writes to the portal or the outbox: it exercises the same
// transport the server would use, so a green run means the server will work.

import { buildMailer, loadEnv } from '../src/mail/factory.js';
import { markdownToEpub } from '../src/core/index.js';
import { composeBookEmail } from '../src/mail/message.js';

const env = loadEnv();
const args = process.argv.slice(2);
const wantsKindle = args.includes('--kindle');
const recipient = wantsKindle ? (env.KINDLE_ADDRESS || '').trim() : (args.find((a) => a.includes('@')) || '').trim();

const DIAGNOSIS = [
  [/EAUTH|535|534/i, 'The server rejected the login. On Gmail this almost always means SMTP_PASS is an account password rather than a 16 character app password, or 2-Step Verification is not on. See docs/EMAIL-SETUP.md.'],
  [/ENOTFOUND|EAI_AGAIN/i, 'The SMTP host name did not resolve. Check SMTP_HOST for a typo.'],
  [/ECONNREFUSED/i, 'The connection was refused. Check SMTP_PORT (587 for STARTTLS, 465 for implicit TLS).'],
  [/ETIMEDOUT|ESOCKET|ECONNRESET/i, 'The connection timed out or was reset. A firewall blocking outbound SMTP is the usual cause; some networks and hosting providers block port 25 and 587.'],
  [/self.signed|unable to verify|certificate/i, 'The TLS certificate did not verify. That is worth understanding rather than working around: it can mean something is intercepting the connection.'],
  [/wrong version number/i, 'TLS mismatch: port 587 needs SMTP_SECURE=false (STARTTLS), port 465 needs SMTP_SECURE=true.'],
];

function explain(message) {
  for (const [pattern, advice] of DIAGNOSIS) if (pattern.test(message)) return advice;
  return null;
}

const mailer = buildMailer(env);
if (!mailer) {
  console.error('No mail transport is configured.');
  console.error('Set SMTP_HOST and MAIL_FROM in .env (see docs/EMAIL-SETUP.md), or MAIL_TRANSPORT=log for a dry run.');
  process.exit(2);
}

console.log(`transport : ${mailer.kind}`);
console.log(`settings  : ${mailer.describe()}`);
if (env.SMTP_USER) console.log(`user      : ${env.SMTP_USER}`);
console.log(`password  : ${env.SMTP_PASS ? `set, ${env.SMTP_PASS.replace(/\s/g, '').length} characters` : 'NOT SET'}`);
if (wantsKindle && !recipient) {
  console.error('--kindle needs KINDLE_ADDRESS in .env');
  process.exit(2);
}

// Settings that are wrong in a way the eventual error message will not explain.
// A 465/STARTTLS mismatch, for instance, surfaces only as a timeout.
if (mailer.kind === 'smtp') {
  const port = Number(env.SMTP_PORT || 587);
  const secure = env.SMTP_SECURE === undefined ? port === 465 : /^(1|true|yes|on)$/i.test(env.SMTP_SECURE);
  const notes = [];
  if (port === 465 && !secure) notes.push('port 465 is implicit TLS: set SMTP_SECURE=true (otherwise the connection just hangs)');
  if (port === 587 && secure) notes.push('port 587 is STARTTLS: set SMTP_SECURE=false');
  if (/gmail\.com|googlemail\.com/i.test(env.SMTP_HOST || '')) {
    const length = (env.SMTP_PASS || '').replace(/\s/g, '').length;
    if (length && length !== 16) notes.push(`Gmail app passwords are 16 characters, this one is ${length}: an account password will be rejected`);
    const from = (env.MAIL_FROM || '').match(/[^\s<>]+@[^\s<>]+/);
    if (from && env.SMTP_USER && from[0].toLowerCase() !== env.SMTP_USER.toLowerCase()) {
      notes.push(`Gmail sends as ${env.SMTP_USER} unless ${from[0]} is a verified alias, so MAIL_FROM may be rewritten (this matters for the Kindle approved sender list)`);
    }
  }
  for (const note of notes) console.log(`note      : ${note}`);
}

try {
  await mailer.verify();
  console.log(mailer.kind === 'log'
    ? 'connection: not applicable, this is the dry run transport'
    : 'connection: ok, the server accepted the login');
} catch (err) {
  console.error(`connection: FAILED, ${err.message}`);
  const advice = explain(`${err.code || ''} ${err.message}`);
  if (advice) console.error(`\n${advice}`);
  process.exit(1);
}

if (!recipient) {
  console.log('\nNo recipient given, so nothing was sent.');
  console.log('Run `node scripts/mail-check.mjs you@example.com` to send a real test book.');
  process.exit(0);
}

const result = await markdownToEpub(
  `# md2epub test\n\nIf you are reading this on your device, the whole path works: Markdown in, EPUB out, delivered by email.\n\n## What was tested\n\n- SMTP connection and login\n- EPUB generation\n- Attachment delivery\n`,
  { title: 'md2epub test', author: 'md2epub' },
);

try {
  const info = await mailer.send({ to: recipient, ...composeBookEmail(result, { note: 'This is a test message from scripts/mail-check.mjs.' }) });
  console.log(`sent      : ${result.filename} (${(result.bytes.length / 1024).toFixed(1)} KB) to ${recipient}`);
  console.log(`message id: ${info.messageId}`);
  if (recipient.endsWith('@kindle.com') || recipient.endsWith('@free.kindle.com')) {
    console.log('\nAmazon accepts the message only if the MAIL_FROM address is on your Approved');
    console.log('Personal Document E-mail List, and delivery takes a few minutes. A rejected');
    console.log('message usually bounces back to MAIL_FROM, so check that inbox if nothing arrives.');
  }
} catch (err) {
  console.error(`send      : FAILED, ${err.message}`);
  const advice = explain(`${err.code || ''} ${err.message}`);
  if (advice) console.error(`\n${advice}`);
  process.exit(1);
}
