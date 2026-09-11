---
name: send-to-kindle
description: Convert a Markdown document, a folder of docs, or a web page to EPUB and email it to a Kindle. Use when the user says "send that to my kindle", "make that a book", "I want to read this on my kindle", or asks for a document to be turned into an epub. Also covers reading a Karakeep read-later queue as a book.
---

# send-to-kindle

A long document is easier to read on a Kindle than on a laptop. This turns one
into a book and mails it to the device.

The tool is `md2epub`. If it is not on PATH, run it as
`node <checkout>/src/cli.js` instead. Its configuration (SMTP, the `@kindle.com`
address as `KINDLE_ADDRESS`, diagram rendering) lives in a `.env` beside the
checkout, and is read no matter which directory you run from. On a machine
with no checkout at all, the same converter is reachable as a portal over HTTP;
see "No md2epub here? Use the portal" at the end.

## The command

```bash
md2epub <path> --kindle
```

That converts and sends. Everything else is a variation:

```bash
md2epub HANDOFF.md --kindle                        # one document
md2epub ./docs --kindle                            # a folder, one chapter per file
md2epub ./docs -r --title "Neon Exile Docs" --kindle   # include subdirectories
md2epub notes.md --diagrams --kindle               # render mermaid to images
md2epub https://example.com/article --kindle       # a web page
md2epub --karakeep --limit 10 --kindle             # his read-later queue
md2epub report.md -o report.epub                   # write a file instead of sending
```

Useful flags: `--title` and `--author` (only needed when the document has no
frontmatter and no `#` heading), `--split 2` (start a chapter at every `##` for
one long document), `--no-images`, `--no-cover`.

## Ask before sending

Sending is outward facing and cannot be recalled, so **confirm the document and
say what will be sent before running it with `--kindle`**, unless the user has
just asked for that exact document in the current turn.

Two things to check first:

- **Secrets.** A discovery or handoff document may quote an API key, a token or
  a password. Mailing it puts it in Amazon's hands and in his mail account
  permanently. Skim the document; if it carries a credential, say so and ask
  before sending rather than after.
- **Size.** A send over 45 MB is refused (Amazon's limit is 50 MB). If that
  happens, `--no-images` or a smaller `--limit` is the fix, not splitting the
  send into several mails.

## What success looks like

```
Neon Exile Docs, 8 document(s), 8 chapter(s), 1 image(s), 61.3 KB
sent to <address> (<message id>)
```

Delivery takes a few minutes and the Kindle needs Wi-Fi. Nothing arrives if the
device is asleep and off the network; that is normal, it lands when it wakes.

Warnings on stderr are informational, not failures: links that leave the book,
images that could not be fetched, a diagram that would not render. The book is
still valid and was still sent.

## When it does not work

- **"email is not configured"** - the `.env` is missing `SMTP_HOST` or
  `MAIL_FROM`. `npm run mail:check` in the checkout diagnoses it, and
  `docs/EMAIL-SETUP.md` is the full guide.
- **Sends fine, never arrives** - the `MAIL_FROM` address must be on Amazon's
  Approved Personal Document E-mail List. Nothing bounces; it is dropped.
- **`--diagrams` errors** - the mermaid toolchain is not installed on this
  machine: `npm run diagrams:install` in the checkout.
- **Nothing renders as a diagram** - only ` ```mermaid ` fences and raw
  `<pre class="mermaid">` blocks are rendered, and only with `--diagrams`.
- **`--karakeep` says nothing had a crawled article** - plenty of saved links
  (X posts, paywalled pages) cannot be crawled. Those are skipped and the limit
  still means readable articles, so raising `--limit` is rarely the answer;
  more likely the queue really is empty of readable items.

To try the whole path without sending anything, put `MAIL_TRANSPORT=log` in the
environment: the message and the attachment are written to `.mail-outbox/` in
the checkout instead.

## No md2epub here? Use the portal

The same converter runs as a web portal, and any machine that can reach it can
send a book without a checkout, a `.env`, or any mail credentials. The address is
in `MD2EPUB_URL` (set per machine in the Claude Code settings); where the server
runs locally it answers on `http://127.0.0.1:8787`.

```bash
PORTAL="${MD2EPUB_URL:-http://127.0.0.1:8787}"
curl -sS "$PORTAL/api/health"
```

`email.configured` must be `true`. `email.kindleDefault: true` means a request
that names no recipient goes to the configured Kindle, which is the normal case:

```bash
curl -sS -F "file=@HANDOFF.md;type=text/markdown" "$PORTAL/api/email"
```

Several files become one book, a chapter each, in the order given:

```bash
curl -sS -F "file=@00-preface.md" -F "file=@01-body.md" -F "title=Project Docs" \
  -F "renderDiagrams=false" "$PORTAL/api/email"
```

Fields, all optional: `title`, `author`, `splitLevel` (`1` starts a chapter at
every `#`, `2` at every `##`, `0` keeps one chapter), `tocDepth`, `typographer`,
`generateCover`, `renderDiagrams` (send `false` unless the book has mermaid
fences; rendering spawns a browser per conversion), `note` and `subject` for the
mail. YAML frontmatter is picked up. To get the file back instead of mailing it,
POST the same form to `/api/convert -o book.epub`.

Success is JSON:

```
{"ok":true,"to":"<address>","filename":"...epub","size":246627,"chapters":11,"warnings":[],"messageId":"<...>"}
```

The confirm-before-sending rule above applies exactly as it does to `--kindle`.

What the refusals mean:

- 403 "only sends to approved addresses": the portal is locked to Matt's Kindle
  by `MAIL_ALLOWED_RECIPIENTS`. Do not pass a different address; leave the field out.
- 400 "No recipient": this server has no `KINDLE_ADDRESS`, so pass `-F email=...`.
- 413: the source is over the server's limit (8 MB of Markdown); drop images or
  split the book.
- 429: the hourly send limit (20 by default) is spent; wait, do not retry in a loop.

The portal is also the path for a human on a phone: it has a paste box, a file
drop and a URL tab.
