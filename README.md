# md2epub

Paste Markdown into a web portal or upload a `.md` file, get back a valid EPUB 3.
Download it, or have it emailed to an address you type in.

Every fixture in `test/fixtures/` is checked against the real
[EPUBCheck](https://github.com/w3c/epubcheck) 5.3.0 on every `npm run validate`,
including a hostile input fixture full of scripts, malformed HTML and broken
links. Output currently passes with zero errors and zero warnings.

## Quick start

```bash
npm install
npm start                      # http://127.0.0.1:8787
```

That is the whole download path. Email needs a few more lines of config, below.

```bash
npm test                       # 71 tests: converter, API, guards and the portal itself
npm run epubcheck:install      # fetches EPUBCheck into tools/ (needs java + unzip)
npm run validate               # converts every fixture and runs EPUBCheck over it
```

## Email

Copy `.env.example` to `.env` and fill in the SMTP block:

```ini
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=someone@example.com
SMTP_PASS=an-app-password
MAIL_FROM=md2epub <someone@example.com>
```

Restart. The portal picks this up through `/api/health` and enables its email
controls; without it the controls stay disabled and `/api/email` answers 503.
TLS is required by default (`STARTTLS` on 587, implicit TLS on 465). Gmail and
Fastmail both need an app password rather than the account password.

To exercise the email path without credentials, set `MAIL_TRANSPORT=log`. The
message and its attachment are written to `.mail-outbox/` instead of being sent,
and the portal says so in its confirmation.

**Before exposing this beyond localhost**, set `MAIL_ALLOWED_RECIPIENTS`.
Without it, anyone who can reach the portal can send attachments from your
address to anywhere. Entries are full addresses or `@domain` suffixes:

```ini
MAIL_ALLOWED_RECIPIENTS=me@example.com,@kindle.com
```

`MAIL_RATE_PER_HOUR` (default 20) caps sends per client address per hour.

Amazon's Send to Kindle accepts EPUB, so `@kindle.com` in the allowlist plus
your device address in the portal is a working Markdown to Kindle pipeline. The
sending address has to be on your Approved Personal Document E-mail List.

## Command line

The CLI is the only front end that can resolve images by relative path, because
it is the only one that knows where the Markdown file lives.

```bash
node src/cli.js book.md -o book.epub --author "Ada Lovelace" --cover cover.jpg
cat book.md | node src/cli.js - --title "From A Pipe"
node src/cli.js --help
```

## HTTP API

Both endpoints accept `multipart/form-data` (with `markdown` text or a `file`
upload, plus an optional `cover` image) or `application/json` (with `markdown`,
no cover).

| Endpoint | Answers |
|---|---|
| `POST /api/convert` | the EPUB itself, with `Content-Disposition`, `X-Md2Epub-Chapters` and any conversion notes in `X-Md2Epub-Warnings` |
| `POST /api/email` | JSON: `{ok, to, filename, size, chapters, warnings, messageId, dryRun}` |
| `GET /api/health` | whether email is configured, and the current limits |

Fields, all optional except the source: `title`, `author`, `language`,
`publisher`, `description`, `rights`, `subjects`, `splitLevel` (heading level
that starts a new chapter, 0 for one file), `tocDepth`, `typographer`,
`embedRemoteImages`, and for `/api/email`, `email`, `subject` and `note`.

```bash
curl -F "markdown=# Hello

World." http://127.0.0.1:8787/api/convert -o hello.epub
curl -F "file=@book.md" -F "email=me@example.com" http://127.0.0.1:8787/api/email
```

## What the conversion does

- YAML frontmatter (`title`, `author`, `language`, `publisher`, `description`,
  `rights`, `date`, `subjects`, `identifier`) becomes EPUB metadata. Form fields
  win over frontmatter, and frontmatter wins over the first `#` heading.
- Each level 1 heading starts a new XHTML file. Configurable, including off.
- Every heading gets a stable id, so in document links keep working after the
  split; a link to another chapter is rewritten to that chapter's file.
- A nested table of contents (`nav.xhtml`) plus an NCX for older readers.
- Data URI images are decoded into the book. Local paths work from the CLI.
  Remote URLs are only fetched with `embedRemoteImages`, because EPUB forbids
  referencing images over the network, and anything that cannot be packaged
  degrades to its alt text with a warning rather than breaking the book.
- Optional cover image, which becomes a cover page plus the `cover-image`
  manifest property that readers use for the shelf thumbnail.

### Raw HTML in the source is sanitised, not trusted

Markdown routinely carries raw HTML. EPUB content documents are parsed as XML,
so an unclosed `<br>` or a bare `&nbsp;` is not sloppy markup, it is an invalid
book. `src/core/html.js` re-serialises every fragment: tags are balanced and
void elements closed, named entities become characters, ids that XML rejects are
repaired, and `script`, `iframe`, `form`, event handlers, `javascript:` URLs and
`style` rules containing `url()` are removed. That is why the hostile fixture
validates clean.

### Fetching remote images is guarded

With `EMBED_REMOTE_IMAGES=true`, a pasted document can make the server issue
outbound requests. `src/net.js` resolves each host and refuses private,
loopback, link local, multicast and CGNAT (100.64/10, which includes tailnet)
addresses, re-checking on every redirect hop rather than trusting the first.
It is off by default.

## Deploying to Cloudflare Workers

The core and the API are runtime agnostic, so the same code runs on Workers.
`src/worker.js` swaps the two things a Worker cannot do natively: static files
come from the assets binding, and mail goes over HTTP.

```bash
npx wrangler dev             # verified working locally
npx wrangler deploy
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
```

Workers have no outbound SMTP, so the Worker build uses Resend rather than
nodemailer. Without those two secrets the deployed portal is download only.
Note: the Resend request shape is unit tested against a stub, but it has not
been exercised against the live Resend API from here, and Resend only delivers
to arbitrary recipients once you have verified a sending domain.

## Layout

```
src/core/     runtime agnostic converter (no fs, no env, no Node built-ins)
  index.js      orchestration and metadata precedence
  markdown.js   Markdown to chapters, heading ids, table of contents
  html.js       HTML to well formed, script free XHTML
  epub.js       package document, nav, NCX, OCF zip
  images.js     data URIs, remote fetches, local files, format sniffing
src/app.js    Hono API shared by both runtimes
src/server.js Node entry: static files, .env, SMTP
src/worker.js Cloudflare entry: assets binding, HTTP mail
src/cli.js    command line
public/       the portal, no build step
test/         node:test suites, including the portal driven under jsdom
scripts/      EPUBCheck install and the fixture validation run
```

## Limits and known gaps

- Uploads are capped at 8 MB of Markdown and 12 MB per image (configurable).
- Only the single Markdown file is uploaded, so relative image paths cannot be
  resolved through the portal. Use a data URI, or the CLI.
- No footnote, math or Mermaid support; those are markdown-it plugins away.
- The rate limiter is in process memory, so it resets on restart and is per
  Worker isolate rather than global.
