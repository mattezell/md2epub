#!/usr/bin/env node
// Install the agent skill into ~/.claude/skills so every Claude Code session
// can reach it, not only sessions opened inside this repo.
//
// A symlink, so editing the version-controlled copy is enough; falls back to a
// copy where symlinks are not available.

import { mkdir, symlink, rm, cp, readFile, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'send-to-kindle';
const source = join(root, 'skills', name);
const skillsDir = join(homedir(), '.claude', 'skills');
const target = join(skillsDir, name);

if (!existsSync(join(source, 'SKILL.md'))) {
  console.error(`missing ${join(source, 'SKILL.md')}`);
  process.exit(1);
}

await mkdir(skillsDir, { recursive: true });

if (existsSync(target)) {
  const stat = await lstat(target);
  if (stat.isSymbolicLink() && (await realpath(target)) === source) {
    console.log(`already installed: ${target} -> ${source}`);
    process.exit(0);
  }
  console.log(`replacing existing ${target}`);
  await rm(target, { recursive: true, force: true });
}

try {
  await symlink(source, target, 'dir');
  console.log(`linked ${target} -> ${source}`);
} catch (err) {
  console.log(`symlink failed (${err.code}), copying instead`);
  await cp(source, target, { recursive: true });
  console.log(`copied to ${target} (re-run this after editing the skill)`);
}

// Prove the harness can read it through the installed path.
const text = await readFile(join(target, 'SKILL.md'), 'utf8');
const description = /^description:\s*(.+)$/m.exec(text);
console.log(`readable through the installed path: ${text.length} bytes`);
console.log(`description: ${description ? `${description[1].slice(0, 80)}...` : 'MISSING'}`);
