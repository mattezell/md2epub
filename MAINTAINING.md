# Maintaining md2epub

Companion to the README, which explains what the project is and how to use it.
This file is about keeping an installation alive: the checks that matter, the
traps this project has already paid for, routine upkeep, and the shape of the
code for anyone changing it. What is worth doing next lives in
[ROADMAP.md](ROADMAP.md).

## Where things live

Configuration is one gitignored `.env` beside the checkout. Nothing else holds
credentials: the systemd unit written by `npm run service:print` has no
`EnvironmentFile`, and the app finds `.env` from its install path, so the CLI
works from any directory.

| Piece | Installed by | Notes |
|---|---|---|
| Service | `npm run service:print` (see the README) | loopback `127.0.0.1:8787` by default; put a proxy in front for anything else |
| CLI | `npm link` | `md2epub` on PATH points at the checkout |
| Agent skill | `npm run skill:install` | symlink into `~/.claude/skills`, so edits are live |
| EPUBCheck | `npm run epubcheck:install` | gitignored `tools/` |
| Mermaid toolchain | `npm run diagrams:install` | gitignored `tools/`, about half a gigabyte |

## The loop that matters

```bash
npm test                  # 157 tests, no network needed
npm run validate          # every fixture through the real EPUBCheck
```

`npm run validate` is the one that earns the "valid EPUB 3" claim. It renders
diagrams and rasterises covers when the local toolchain is present, and says so
when it is not, because silence would read as coverage that does not exist.
Both run in CI on every push (`.github/workflows/ci.yml`).

Never hand over a change to the converter without running `validate`. Four real
bugs were found by it and by a physical Kindle, none by unit tests alone.

## Traps this project has already paid for

Each of these cost a debugging session. They are all covered by tests now, but
the reasoning is worth keeping.

- **An SVG cover is valid EPUB and Kindle ignores it.** The cover is drawn as
  SVG then screenshotted to PNG with the local Chrome. Without a browser it
  stays SVG, and the shelf shows a grey placeholder.
- **Mermaid's default labels are invisible on Kindle.** `htmlLabels: false` is
  load bearing: the default puts label text in a `foreignObject` that e-readers
  will not render, so shapes arrive empty.
- **Links that leave the book are an error, not a warning** (`RSC-026`), and
  documentation written for a docs site is full of them.
- **MDX inline styles** (`style={{...}}`) parse out as invalid CSS and fail
  validation.
- **A feature that cannot run must say so.** Asking for diagrams on a server
  without the toolchain used to be silently ignored; the request now returns a
  warning and the portal disables the control with the reason.
- **The server's startup path needs its own test.** Two crashes hid in a log
  line referring to a variable scoped inside `createServerApp`, because every
  other test drives `createApp` directly. `test/server-boot.test.js` spawns the
  real entry point.
- **Restarting looks like nothing happened if the portal is cached.** Static
  files are served `no-cache` for that reason.

## Routine upkeep

- **Dependencies**: `npm audit --omit=dev` and `npm outdated`. Patched
  2026-09-13 (hono `parseBody` memory exhaustion, nodemailer quadratic
  `addressparser`, js-yaml merge keys). Both advisories that mattered were in
  paths this app uses, so this is worth a monthly glance rather than a yearly
  one.
- **After changing anything in the checkout, restart the service**
  (`sudo systemctl restart md2epub` for the unit from `service:print`). The
  service does not watch files, and a stale service is invisible from the
  outside. `curl -s localhost:8787/api/health` shows what the running instance
  believes it can do.
- **Gmail app passwords are revoked when the Google account password changes.**
  That is the most likely future cause of a silent delivery failure, and the
  symptom is `535-5.7.8` from `npm run mail:check`.
- **The Amazon approved-sender list is browser-side state.** `MAIL_FROM` must be
  on it. Nothing bounces when it is not; mail is simply dropped.
- **EPUBCheck** lives in gitignored `tools/`. `npm run epubcheck:install`
  refetches it; bump `EPUBCHECK_VERSION` to move versions.

## Shape of the code

The core is runtime agnostic on purpose: no filesystem, no env, no Node
built-ins, so the same module serves the CLI, the server and a Worker.
Everything platform specific is injected, and that is the pattern to keep.

```
src/core/     the converter (pure, injected capabilities)
src/app.js    Hono API shared by every runtime
src/server.js Node entry: static files, .env, mail, the browser features
src/cli.js    command line, and the only front end that resolves local images
src/article.js, src/karakeep.js   web input
src/chrome.js, src/diagrams.js    the local browser
skills/       the agent skill (installed by symlink)
```

When adding an input type, convert it to Markdown and hand it to the existing
pipeline rather than building a second one. That is how web pages and the
read-later queue work, and it is why they inherit chapter splitting, the table
of contents, image embedding and the cover for free.
