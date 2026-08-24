// HTTP based mail delivery, for runtimes with no sockets (Cloudflare Workers).
// Nothing here is Node specific, so the Node server can use it too.

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Resend (https://resend.com). POST /emails with a Bearer key; attachments are
 * base64 in the JSON body. Returns null when no API key is configured.
 */
export function createResendMailer(env = {}, fetchImpl = fetch) {
  const apiKey = (env.RESEND_API_KEY || '').trim();
  const from = (env.MAIL_FROM || '').trim();
  if (!apiKey || !from) return null;

  return {
    kind: 'resend',
    describe: () => `Resend as ${from}`,
    verify: async () => true,
    async send({ to, subject, text, html, attachments }) {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to,
          subject,
          text,
          html,
          reply_to: (env.MAIL_REPLY_TO || '').trim() || undefined,
          attachments: (attachments || []).map((a) => ({
            filename: a.filename,
            content: toBase64(a.content),
            content_type: a.contentType,
          })),
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.message || body.error || `Resend answered ${response.status}`);
      }
      return { messageId: body.id, accepted: [to], rejected: [] };
    },
  };
}

export const _internals = { toBase64 };
