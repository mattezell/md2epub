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

### Fixed

- README: the slim tier is selected with `MD2EPUB_TARGET=slim docker compose
  up`; the previous line was not valid Compose syntax. Test count corrected.

### Security

- Patched three advisories in production dependencies (2026-09-13): hono
  `parseBody()` memory exhaustion through unbounded dot-notation nesting, which
  both API endpoints were exposed to; nodemailer's quadratic `addressparser`;
  js-yaml merge-key CPU exhaustion.

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
