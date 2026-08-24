# Setting up email delivery

md2epub sends over plain SMTP, so any mail service that offers an SMTP endpoint
works. This page covers Gmail in full, because it is the least effort for a
personal setup, then the alternatives worth knowing and when each is the better
choice.

Whatever you pick, check it before you rely on it:

```bash
node scripts/mail-check.mjs                  # connect and log in, send nothing
node scripts/mail-check.mjs you@example.com  # also send a real test book
node scripts/mail-check.mjs --kindle         # send the test book to KINDLE_ADDRESS
```

It prints the settings it resolved, flags configuration that is wrong in a way
the eventual error will not explain, and turns SMTP failures into a specific
cause rather than a stack trace.

## Gmail

Gmail needs an **app password**, not your account password. Google finished
removing plain password access to SMTP in May 2025, so an account password now
fails with `535-5.7.8 Username and Password not accepted` no matter how correct
it is.

### 1. Turn on 2-Step Verification

App passwords do not exist without it. Google Account, Security, 2-Step
Verification. Note the exclusions: app passwords are unavailable on accounts
using **security keys as the only second factor**, on accounts with **Advanced
Protection**, and on many **Workspace, school and organisation accounts** where
the administrator has disabled them. If you are on a locked down Workspace
account, use one of the alternatives below rather than fighting it.

### 2. Create the app password

Go to <https://myaccount.google.com/apppasswords>, name it something you will
recognise later ("md2epub"), and copy the 16 character code. Google shows it
once. It is revoked automatically if you change your account password, and you
can revoke it yourself from the same page.

### 3. Put it in `.env`

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_FROM=md2epub <you@gmail.com>
```

The spaces Google displays in the code are cosmetic; with or without them is
fine. Port 587 is STARTTLS and is the default. Port 465 also works, but then you
must set `SMTP_SECURE=true`, otherwise the connection hangs until it times out
rather than telling you what is wrong.

`MAIL_FROM` should be the same address as `SMTP_USER`. Gmail rewrites the From
header to the authenticated account unless the address is a verified alias, and
a rewritten From is exactly what breaks Kindle delivery.

### 4. Check it

```bash
node scripts/mail-check.mjs you@gmail.com
```

### Limits and caveats

- **500 messages a day** on a personal account, 2,000 on Workspace. Irrelevant
  for sending yourself documents, worth knowing before you point anything
  automated at it.
- Gmail is a mailbox provider, not a transactional sender. Do not use it to send
  to other people at volume; that is what the services below are for.
- Some networks and most cloud hosts block outbound SMTP ports. If the check
  times out on a VPS while working from your laptop, that is the cause, and an
  HTTP API provider is the way around it.

## Sending to a Kindle

Amazon's Send to Kindle accepts EPUB by email, with three requirements:

1. **The sending address must be approved.** Amazon, Manage Your Content and
   Devices, Preferences, Personal Document Settings, Approved Personal Document
   E-mail List. Add the exact address in your `MAIL_FROM`. Mail from anywhere
   else is dropped, usually silently.
2. **Send to your device address**, the `@kindle.com` one on that same page. Put
   it in `.env` as `KINDLE_ADDRESS` and use `md2epub <file> --kindle`.
3. **Stay under 50 MB per message**, across at most 25 attachments. Converted
   Markdown lands between 3 KB and 100 KB, so this is not a real constraint.

```ini
KINDLE_ADDRESS=you@kindle.com
MAIL_ALLOWED_RECIPIENTS=@kindle.com,you@gmail.com
```

`MAIL_ALLOWED_RECIPIENTS` matters if the portal is reachable by anyone else: it
stops the server being used to mail attachments from your address to strangers.

Delivery takes a few minutes and the device needs Wi-Fi. A rejected message
normally bounces to `MAIL_FROM`, so check that inbox when nothing arrives.

## Alternatives

| Service | Endpoint | Auth | Free tier | Best when |
|---|---|---|---|---|
| **Gmail** | `smtp.gmail.com:587` | 16 char app password | 500/day | Personal use, you already have the account |
| **Fastmail** | `smtp.fastmail.com:465` (`SMTP_SECURE=true`) | app password | paid only | You already pay for it; app passwords are first class and it sends from your own domain |
| **Resend** | `smtp.resend.com:587` | API key as the password | 3,000/month, 100/day | You want a real sending domain with DKIM, and the same key works from a Worker |
| **Amazon SES** | `email-smtp.<region>.amazonaws.com:587` | SES SMTP credentials (not your AWS keys) | 3,000 message charges/month for 12 months | Cheapest at volume, and you are already in AWS |
| **Brevo** | `smtp-relay.brevo.com:587` | login plus SMTP key | 300/day | You want a free tier without a credit card |
| **Postmark** | `smtp.postmarkapp.com:587` | server token as user and password | 100/month | Deliverability matters more than price |

All of them drop into the same four settings:

```ini
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_your_api_key
MAIL_FROM=md2epub <docs@yourdomain.com>
```

Two things to know before moving off Gmail for the Kindle workflow:

- **A custom domain must be verified with the provider** (SPF and DKIM records)
  before it will send to arbitrary recipients, and unverified domains are
  usually limited to your own address.
- **Whatever address you end up sending from has to be added to Amazon's
  approved list.** Switching providers means updating that list, and forgetting
  is the most common reason a working setup suddenly stops delivering.

## Running without credentials

`MAIL_TRANSPORT=log` writes the message and its attachment to `.mail-outbox/`
instead of sending. The portal and the CLI both say the send was a dry run, so
you can exercise the whole path, and open the resulting `.epub`, before any
account exists.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `535-5.7.8 Username and Password not accepted` | Account password instead of an app password, or 2-Step Verification is off |
| The check hangs, then `Timeout` | Port 465 without `SMTP_SECURE=true`, or outbound SMTP is blocked by the network |
| `ECONNREFUSED` | Wrong port |
| `ENOTFOUND` / `EAI_AGAIN` | Typo in `SMTP_HOST` |
| `wrong version number` | TLS mode does not match the port: 587 is STARTTLS, 465 is implicit TLS |
| Sends fine, never arrives on the Kindle | `MAIL_FROM` is not on Amazon's approved list, or Gmail rewrote it to a different address |
| Portal says email is not configured | `SMTP_HOST` or `MAIL_FROM` is missing; the server reads `.env` at startup, so restart after editing it |
