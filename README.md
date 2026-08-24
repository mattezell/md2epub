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
npm test                       # 118 tests: converter, API, guards and the portal itself
npm run epubcheck:install      # fetches EPUBCheck into tools/ (needs java + unzip)
npm run diagrams:install       # optional: mermaid rendering (see Diagrams below)
npm run validate               # converts every fixture and runs EPUBCheck over it
```

## Email

Copy `.env.example` to `.env` and fill in the SMTP block:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=a-16-character-app-password
MAIL_FROM=md2epub <you@gmail.com>
```

Then check it before relying on it:

```bash
node scripts/mail-check.mjs you@example.com
```

**[docs/EMAIL-SETUP.md](docs/EMAIL-SETUP.md) is the full guide**: Gmail step by
step (app passwords are mandatory now, account passwords stopped working in May
2025), the Kindle approved sender requirement, a comparison of Fastmail, Resend,
Amazon SES, Brevo and Postmark, and a table of what each failure message means.

Restart after editing `.env`. The portal picks the configuration up through
`/api/health` and enables its email controls; without it the controls stay
disabled and `/api/email` answers 503.

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

### Markdown to Kindle

Put your device address in `.env` and send from the terminal:

```ini
KINDLE_ADDRESS=you@kindle.com
MAIL_ALLOWED_RECIPIENTS=@kindle.com
```

```bash
md2epub HANDOFF.md --kindle          # one document
md2epub ./docs --kindle              # a whole folder as one book
```

The address in `MAIL_FROM` must be on your Amazon Approved Personal Document
E-mail List or the message is dropped, usually without a bounce. Amazon's limit
is 50 MB per email; converted Markdown lands between 3 KB and 100 KB.
[docs/EMAIL-SETUP.md](docs/EMAIL-SETUP.md) has the details.

## Command line

The CLI knows where the Markdown lives, so it is the front end that can resolve
relative images, bundle a folder into one book, and send without a browser.

```bash
npm link                             # then md2epub works anywhere

md2epub book.md -o book.epub --author "Ada Lovelace" --cover cover.jpg
md2epub ./docs --title "Project Docs" --kindle
md2epub README.md docs/ -r --email me@example.com
cat book.md | md2epub - --title "From A Pipe"
md2epub --help
```

Without `npm link`, `node src/cli.js` does the same thing.

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

## Several documents, one book

Pass more than one file, or a directory, and each document becomes a chapter of
a single book. This is the shape most project documentation is in.

```bash
md2epub ./docs -r --title "Neon Exile Docs" --kindle
```

- Documents are ordered README first, then alphabetically, so numeric prefixes
  (`01-intro.md`) do what you expect.
- **Links between documents become links between chapters**, including
  `../api/reference.md#endpoints`. Links to anything not in the book degrade to
  plain text, because EPUB rejects a link that leaves the container.
- Heading ids stay unique across the whole book, and two documents can each
  reference their own `diagram.png` without colliding.
- The contents nests each document's headings under its own entry.

The portal accepts several files at once for the same result.

## Diagrams

Mermaid diagrams can be rendered to images and embedded, so they arrive as
pictures on a device rather than as a wall of diagram source.

```bash
npm run diagrams:install       # once: mermaid-cli, pointed at your own Chrome
md2epub notes.md --diagrams
```

The toolchain is deliberately **not** a dependency of this project: it is around
500 MB on disk. The installer puts it in `tools/mermaid/` and reuses the Chrome
already on the machine rather than downloading a second Chromium. Without it, a
diagram stays an ordinary code block, which is also what happens to any single
diagram that fails to render.

Both ways of writing a diagram are picked up:

- ` ```mermaid ` fences.
- Raw `<pre class="mermaid">` blocks, which is what documentation written for a
  site that renders mermaid in the browser tends to use, because syntax
  highlighters intercept the fence first.

A diagram inside a ` ```html ` example is left alone: documentation *about*
diagrams should not sprout pictures.

Defaults are chosen for e-ink: the `neutral` theme (the standard palette turns
to mud on a 16 level grayscale screen), a white background, 1072 pixels wide at
2x, and PNG rather than SVG because Kindle's converter is unreliable with SVG.
`--diagram-theme`, `--diagram-format` and `--diagram-scale` override those.
Inline `style` directives inside a diagram win over the theme, so a diagram that
carries its own colours keeps them.

Rendered images are cached by content under `~/.cache/md2epub/diagrams`, and an
identical diagram repeated across a folder of documents is rendered once. A
first render costs about half a second; the cached path is about 40x faster.

To enable it on the server, set `RENDER_DIAGRAMS=true`. Think before doing that
on an exposed portal: every conversion then spawns a browser.

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
  manifest property that readers use for the shelf thumbnail. When none is
  given, a cover is drawn from the title, author and date, so a shelf of
  converted documents is distinguishable. `--no-cover` turns that off.
- **The drawn cover is rasterised to PNG** using the local Chrome, at 1600x2560.
  It is drawn as SVG, which is valid EPUB, but Kindle's converter does not
  render an SVG cover: the book arrives with the generic grey placeholder
  instead. Verified on a device, which is the only way to find that out. An
  uploaded SVG cover gets the same treatment. Without a browser the cover stays
  SVG and the CLI says so once; set `CHROME_PATH` if yours is somewhere unusual,
  or `RASTERIZE_COVER=false` on the server to skip it.
- A document with no `#` heading takes its title from its file name, so
  `01-design-notes.md` becomes "Design Notes" rather than "Untitled".

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
src/mail/     transports (SMTP, HTTP, dry run) and the shared message body
src/chrome.js    finding and driving the local browser
src/diagrams.js  mermaid rendering through it
public/       the portal, no build step
docs/         email setup guide
test/         node:test suites, including the portal driven under jsdom
scripts/      EPUBCheck install and the fixture validation run
```

## Limits and known gaps

- Uploads are capped at 8 MB of Markdown and 12 MB per image (configurable).
- The portal receives files without their folder, so relative image paths
  cannot be resolved there. Use a data URI, or the CLI.
- No footnote or math support; those are markdown-it plugins away.
- Diagram rendering and cover rasterising both need a local browser, so neither
  works on Workers. A Worker deployment draws SVG covers, which Kindle will not
  display.
- The rate limiter is in process memory, so it resets on restart and is per
  Worker isolate rather than global.
