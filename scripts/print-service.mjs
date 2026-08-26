#!/usr/bin/env node
// Print a systemd unit for this checkout, filled in for whoever runs it:
//
//   npm run service:print | sudo tee /etc/systemd/system/md2epub.service
//
// Nothing is written or installed here, so it is safe to run and read first.

import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = await readFile(join(root, 'deploy', 'md2epub.service.template'), 'utf8');
const me = userInfo();

const repository = await readFile(join(root, 'package.json'), 'utf8')
  .then((raw) => (JSON.parse(raw).repository || {}).url || '')
  .then((url) => url.replace(/^git\+/, '').replace(/\.git$/, ''))
  .catch(() => '');

process.stdout.write(template
  .replace(/__USER__/g, process.env.SUDO_USER || me.username)
  .replace(/__GROUP__/g, process.env.SUDO_USER || me.username)
  .replace(/__DIR__/g, root)
  .replace(/__NODE__/g, process.execPath)
  .replace(/__REPO__/g, repository || 'https://github.com/mattezell/md2epub'));
