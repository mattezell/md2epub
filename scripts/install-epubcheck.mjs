#!/usr/bin/env node
// Download EPUBCheck into ./tools so `npm run validate` has something to run.
// EPUBCheck is a Java program; this needs a JRE on PATH.

import { mkdir, rm, writeFile, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(root, 'tools');
const VERSION = process.env.EPUBCHECK_VERSION || '5.3.0';
const url = `https://github.com/w3c/epubcheck/releases/download/v${VERSION}/epubcheck-${VERSION}.zip`;

const target = join(toolsDir, `epubcheck-${VERSION}`, 'epubcheck.jar');
if (existsSync(target) && !process.env.FORCE) {
  console.log(`EPUBCheck already installed: ${target}`);
  process.exit(0);
}

console.log(`Downloading ${url}`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status}`);
  process.exit(1);
}

await mkdir(toolsDir, { recursive: true });
const zipPath = join(toolsDir, `epubcheck-${VERSION}.zip`);
await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));

try {
  await run('unzip', ['-q', '-o', zipPath, '-d', toolsDir]);
} catch (err) {
  console.error('Could not unzip the download. Is `unzip` installed?');
  console.error(err.message);
  process.exit(1);
}
await rm(zipPath, { force: true });

if (!existsSync(target)) {
  console.error(`Unpacked, but ${target} is missing. Contents: ${(await readdir(toolsDir)).join(', ')}`);
  process.exit(1);
}
await chmod(target, 0o644);

try {
  const { stdout, stderr } = await run('java', ['-jar', target, '--version']);
  console.log(`${(stdout + stderr).trim().split('\n').slice(-1)[0]} installed at ${target}`);
} catch {
  console.log(`Installed at ${target}, but java is not on PATH so it could not be smoke tested.`);
}
