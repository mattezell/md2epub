import yaml from 'js-yaml';

const FENCE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split leading YAML frontmatter off a Markdown document.
 * Unparseable frontmatter is left in the body rather than thrown away.
 * @returns {{ data: object, body: string, warnings: string[] }}
 */
export function parseFrontmatter(source) {
  const warnings = [];
  const match = FENCE.exec(source);
  if (!match) return { data: {}, body: source, warnings };

  let data;
  try {
    data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    warnings.push(`Frontmatter is not valid YAML and was kept as body text: ${err.message.split('\n')[0]}`);
    return { data: {}, body: source, warnings };
  }
  if (data === null || data === undefined) return { data: {}, body: source.slice(match[0].length), warnings };
  if (typeof data !== 'object' || Array.isArray(data)) {
    warnings.push('Frontmatter did not parse to a mapping and was ignored.');
    return { data: {}, body: source.slice(match[0].length), warnings };
  }
  return { data, body: source.slice(match[0].length), warnings };
}

const first = (obj, keys) => {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
};

const toList = (value) => {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\s*[,;]\s*/);
  return list.map((v) => String(v).trim()).filter(Boolean);
};

/** Map frontmatter keys onto the metadata the packager understands. */
export function metadataFromFrontmatter(data) {
  const meta = {};
  const title = first(data, ['title', 'name']);
  if (title !== undefined) meta.title = String(title).trim();

  const authors = toList(first(data, ['author', 'authors', 'creator', 'creators', 'by']));
  if (authors.length) meta.authors = authors;

  const language = first(data, ['language', 'lang']);
  if (language !== undefined) meta.language = String(language).trim();

  const description = first(data, ['description', 'summary', 'abstract']);
  if (description !== undefined) meta.description = String(description).trim();

  const publisher = first(data, ['publisher']);
  if (publisher !== undefined) meta.publisher = String(publisher).trim();

  const rights = first(data, ['rights', 'copyright', 'license']);
  if (rights !== undefined) meta.rights = String(rights).trim();

  const identifier = first(data, ['identifier', 'uuid', 'isbn', 'id']);
  if (identifier !== undefined) meta.identifier = String(identifier).trim();

  const date = first(data, ['date', 'published', 'pubdate']);
  if (date !== undefined) meta.date = String(date).trim();

  const subjects = toList(first(data, ['subjects', 'tags', 'keywords', 'categories']));
  if (subjects.length) meta.subjects = subjects;

  return meta;
}
