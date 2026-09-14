# Roadmap

Durable decisions first, then what is worth doing next. Shipped items stay here
with their commit so the history is readable.

## Decisions

- **The core is runtime agnostic.** No filesystem, no env, no Node built-ins in
  `src/core/`; every platform capability is injected. That is why one converter
  serves the CLI, the Node server and a Cloudflare Worker, and it is the rule
  to keep when adding anything.
- **New input types convert to Markdown and join the pipeline.** Web pages and
  the read-later queue work this way, which is why they got chapter splitting,
  the table of contents, image embedding and the cover for free. No second
  pipeline.
- **Valid means EPUBCheck says so.** The W3C validator runs on every fixture in
  the test run and in CI. Unit tests alone missed four real bugs that EPUBCheck
  or a physical Kindle caught.
- **Chromium ships in the default image because Kindle needs a PNG cover.** An
  SVG cover is valid EPUB and Kindle ignores it. The cost is a 1.7 GB default
  image; the slim tier exists for people who do not need covers.
- **No authentication, by design.** The portal is meant for a laptop or a
  private network behind an authenticating proxy. The README says so plainly.
- **A feature that cannot run says so.** Diagrams on a server without the
  toolchain return a warning and the portal disables the control with the
  reason. Silent degradation is treated as a bug.

## Shipped

- 0.1.0: converter, portal, CLI, API, Worker, email, diagrams, covers, web
  input, three container tiers, CI (`f43d115` through `a00e2a3`, 2026-08-24 to
  2026-08-25).
- Default the recipient to `KINDLE_ADDRESS` when a request names none, from
  the API and from the portal (`1357972`, `d640f46`, 2026-09-11).
- Patch three advisories in production dependencies (`f293e1f`, 2026-09-13).
- Open sourced under Apache 2.0, with images published to GHCR (2026-09-14).

## Next, in the order worth taking

1. **Drop Chromium from the default image.** It is 1.66 GB, nearly all
   Chromium, and Chromium is only genuinely required for diagrams. Covers need
   an SVG rasteriser, not a browser: `@resvg/resvg-js` (around 15 MB, prebuilt
   per platform) would make the default image roughly 150 MB with working PNG
   covers, and drop the Chrome requirement for local installs too. Deliberately
   not done yet: it adds a native dependency and changes a cover path that has
   been verified on a real device, so it needs a device check before it ships.
2. **Authentication.** Correct to omit on a private network, wrong anywhere
   else. The first item if the portal is ever exposed publicly.
3. **Exercise the Worker path against live Resend.** `src/worker.js` and the
   Resend mailer are stub tested only, and diagrams and cover rasterising cannot
   work on Workers at all (no browser).
4. **A real SMTP send from a test.** Delivery is proven by use, not by the
   suite; `MAIL_TRANSPORT=log` is as far as tests go.
5. **Footnotes and math.** Both are markdown-it plugins away.
6. **The raw Karakeep list.** Bookmarks that were never crawled (X posts,
   paywalls) are skipped, and the count means readable articles. There is no
   way to ask for everything.

## Engineering hygiene

- The rate limiter is in-process memory: it resets on restart and is per Worker
  isolate rather than global. Fine for one user, not for a shared deployment.
