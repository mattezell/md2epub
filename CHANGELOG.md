# Changelog

All notable changes to md2epub. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Container images published from `main` to `ghcr.io/mattezell/md2epub`
  in all three tiers: `latest` (default), `slim` and `full`.
- A request to `POST /api/email` that names no recipient goes to the server's
  `KINDLE_ADDRESS`, and the portal sends to it when the address box is blank,
  so a machine with no checkout can still "send this to my Kindle".
- `MAINTAINING.md`, `ROADMAP.md` and this changelog.

### Changed

- Licence changed from MIT to Apache 2.0.
- Dependencies brought current (2026-10-27), including three major versions:
  nodemailer 10, `@hono/node-server` 2 and js-yaml 5. Frontmatter now parses
  with js-yaml 5's `CORE_SCHEMA`, which resolves `~`, `True` and `012` the way
  4's `JSON_SCHEMA` did; 5's own `JSON_SCHEMA` is strict and would have turned
  them into strings.
- EPUBCheck 5.4.0. It reports the NCX and the OPF 2 cover `meta` as outdated,
  at usage level only; both stay, because Kindle still reads them.
- The mermaid toolchain is pinned to mermaid-cli 11 in the installer and the
  `full` image. Both installed whatever was latest, and mermaid-cli 12 (which
  drops `--width`) would have shipped diagrams as code blocks.
- CI actions: `checkout` v7, `setup-node` v7, `setup-java` v6.

### Fixed

- README: the slim tier is selected with `MD2EPUB_TARGET=slim docker compose
  up`; the previous line was not valid Compose syntax. Test count corrected.
- Empty or comment-only frontmatter is removed quietly again; js-yaml 5 throws
  on a document with no content, which would have kept it as body text.
- `npm run validate` fails when the diagram toolchain is installed but a
  fixture's diagrams did not render. A diagram that degrades to a code block
  still makes a valid book, so EPUBCheck alone passed a broken toolchain. CI's
  diagram job now runs the test suite as well, so the live diagram tests run
  somewhere.

### Security

- Patched three advisories in production dependencies (2026-09-13): hono
  `parseBody()` memory exhaustion through unbounded dot-notation nesting, which
  both API endpoints were exposed to; nodemailer's quadratic `addressparser`;
  js-yaml merge-key CPU exhaustion.
- Patched four more (2026-10-27): markdown-it 15.0.3 fixes four quadratic-time
  parsing paths that let a few hundred KB of Markdown block the event loop;
  nodemailer 10.2.1; hono 4.13.14; `source-map-js` (transitive). The mermaid
  toolchain still carries a low-severity KaTeX advisory that only Mermaid 12
  fixes.

## [0.1.0] - 2026-08-25

First working version, built over two days.

### Added

- Markdown to EPUB 3 converter with no system dependencies: chapters, heading
  ids, table of contents, NCX, cover, image embedding from data URIs, local
  files and (guarded) remote URLs.
- Many documents into one book, one chapter per file, with cross-document links
  rewritten to chapter links.
- Mermaid diagrams rendered to images through mermaid-cli and a local Chrome,
  with the labels e-readers can actually display.
- Covers drawn from title and author and rasterised to PNG, because Kindle
  shows a placeholder for SVG covers.
- Web pages by URL (Readability extraction, images included) and a Karakeep
  read-later queue as a book.
- A portal with no build step, a CLI (`md2epub`), a Hono API, a Cloudflare
  Worker adapter and a `send-to-kindle` agent skill for Claude Code.
- Email delivery over SMTP, including the Send to Kindle path, with a recipient
  allowlist and rate limits.
- Hostile HTML in the source is sanitised; remote image fetches refuse private,
  loopback, link-local and CGNAT ranges.
- Every fixture, including one full of deliberately hostile HTML, validated
  against the real EPUBCheck in the test run and in CI.
- Container images in three tiers, and a systemd unit generator.
