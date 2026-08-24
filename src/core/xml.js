// XML helpers shared by every generated document.

// Text nodes only need the three markup characters escaped. Attributes also
// need the quote characters, and use numeric references: &apos; is legal XML
// but is not an HTML entity, so a reader that parses the file as HTML would
// show it literally.
const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTR_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Characters XML 1.0 forbids outright (most C0 controls plus the two non-characters).
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;


export function stripIllegalXmlChars(value) {
  return String(value).replace(ILLEGAL_XML_CHARS, '');
}

export function escapeXml(value) {
  return stripIllegalXmlChars(value).replace(/[&<>]/g, (ch) => TEXT_ESCAPES[ch]);
}

export function escapeAttr(value) {
  return stripIllegalXmlChars(value).replace(/[&<>"']/g, (ch) => ATTR_ESCAPES[ch]);
}

// XML NCName-ish: ids and idrefs must not start with a digit.
const VALID_ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function safeId(raw) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+/, '');
  if (!cleaned) return 'id-x';
  return VALID_ID.test(cleaned) ? cleaned : `id-${cleaned}`;
}
