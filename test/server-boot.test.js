// Boots the server the way `npm start` does.
//
// Everything else drives createApp() directly, which never executes the
// startup path. Two crashes have hidden there: a log line referring to a
// variable scoped inside createServerApp(). This test exists to make that
// class of mistake impossible to miss.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function startServer(env = {}) {
  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      MD2EPUB_ENV_FILE: '/nonexistent-so-the-real-env-is-not-read',
      MAIL_TRANSPORT: 'none',
      PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });

  const ready = new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in time.\nstdout:\n${out}\nstderr:\n${err}`)), 20000);
    child.stdout.on('data', () => {
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} before listening.\nstdout:\n${out}\nstderr:\n${err}`));
    });
  });

  return { child, ready, output: () => `${out}${err}` };
}

async function withServer(env, body) {
  const server = startServer(env);
  try {
    const port = await server.ready;
    // Give the remaining startup lines a moment to land.
    await new Promise((r) => setTimeout(r, 250));
    await body(port, server.output());
  } finally {
    server.child.kill('SIGTERM');
  }
}

test('the server starts, stays up, and answers health', { timeout: 40000 }, async () => {
  await withServer({}, async (port, output) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    // Every capability line executed without throwing.
    assert.match(output, /listening on/);
    assert.match(output, /email:/);
    assert.match(output, /covers:/);
    assert.match(output, /diagrams:/);
    assert.match(output, /web:/);
    assert.equal(/ReferenceError|is not defined|Error:/.test(output), false, `startup output carried an error:\n${output}`);
  });
});

test('the server starts with every optional feature switched off', { timeout: 40000 }, async () => {
  await withServer(
    { RENDER_DIAGRAMS: 'false', RASTERIZE_COVER: 'false', KARAKEEP_URL: '', KARAKEEP_API_KEY: '' },
    async (port, output) => {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(body.ok, true);
      assert.equal(body.diagrams, false);
      assert.equal(body.karakeep, false);
      assert.match(output, /diagrams: off/);
      assert.equal(/ReferenceError|is not defined/.test(output), false, `startup output carried an error:\n${output}`);
    },
  );
});

test('the server serves the portal itself', { timeout: 40000 }, async () => {
  await withServer({}, async (port) => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>md2epub<\/title>/);
    assert.match(html, /id="urls"/, 'the web input is present');
    assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status, 200);
  });
});
