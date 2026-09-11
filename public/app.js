// Portal front end. No framework, no build step.

const form = document.getElementById('convert-form');
const textarea = document.getElementById('markdown');
const fileInput = document.getElementById('file');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const downloadBtn = document.getElementById('download-btn');
const emailBtn = document.getElementById('email-btn');
const emailInput = document.getElementById('email');
const emailStatus = document.getElementById('email-status');
// Set from /api/health: the server fills in the configured Kindle when the
// address is left blank.
let kindleDefault = false;
const remoteImagesRow = document.getElementById('remote-images-row');
const diagramsRow = document.getElementById('diagrams-row');
const diagramsNote = document.getElementById('diagrams-note');
const diagramsToggle = document.getElementById('renderDiagrams');
const result = document.getElementById('result');
const resultTitle = document.getElementById('result-title');
const resultBody = document.getElementById('result-body');
const resultWarnings = document.getElementById('result-warnings');
const pasteStats = document.getElementById('paste-stats');
const urlsInput = document.getElementById('urls');
const karakeepRow = document.getElementById('karakeep-row');
const karakeepNote = document.getElementById('karakeep-note');
const karakeepToggle = document.getElementById('karakeep');
const karakeepLimitRow = document.getElementById('karakeep-limit-row');
const webTab = document.getElementById('tab-web');

let activePane = 'paste';

function showPane(name) {
  activePane = name;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.pane === name;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  for (const pane of document.querySelectorAll('.pane')) {
    pane.classList.toggle('is-active', pane.id === `pane-${name}`);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showPane(tab.dataset.pane));
}

function updateStats() {
  const text = textarea.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chapters = (text.match(/^#\s+\S/gm) || []).length;
  const parts = [`${words.toLocaleString()} word${words === 1 ? '' : 's'}`];
  if (chapters) parts.push(`${chapters} level 1 heading${chapters === 1 ? '' : 's'}`);
  pasteStats.textContent = parts.join(', ');
}

textarea.addEventListener('input', updateStats);
updateStats();

// File selection, by click or by drop anywhere on the page. Several files
// become one book, so the whole list is kept.
function acceptFiles(files) {
  const chosen = [...files].filter((file) => file && file.size >= 0);
  if (!chosen.length) return;
  const transfer = new DataTransfer();
  for (const file of chosen) transfer.items.add(file);
  fileInput.files = transfer.files;
  const total = chosen.reduce((sum, file) => sum + file.size, 0);
  fileName.textContent = chosen.length === 1
    ? `${chosen[0].name} (${(total / 1024).toFixed(1)} KB)`
    : `${chosen.length} files, ${(total / 1024).toFixed(1)} KB: ${chosen.map((file) => file.name).join(', ')}`;
  fileName.hidden = false;
  showPane('upload');
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length) acceptFiles(fileInput.files);
});

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && event.target !== dropzone) return;
    dropzone.classList.remove('is-over');
  });
}
document.addEventListener('drop', (event) => {
  const dropped = event.dataTransfer && event.dataTransfer.files;
  if (dropped && dropped.length) acceptFiles(dropped);
});

function report({ ok, title, message, warnings = [] }) {
  result.hidden = false;
  result.classList.toggle('is-error', !ok);
  resultTitle.textContent = title;
  resultBody.textContent = message;
  resultWarnings.innerHTML = '';
  if (warnings.length) {
    resultWarnings.hidden = false;
    for (const warning of warnings) {
      const li = document.createElement('li');
      li.textContent = warning;
      resultWarnings.appendChild(li);
    }
  } else {
    resultWarnings.hidden = true;
  }
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildFormData() {
  const data = new FormData(form);
  // Only send the input the visitor is actually using, so a stale file does not
  // silently win over freshly pasted text (or the other way round).
  // Only the active tab's input is sent, so a stale value in another tab
  // cannot silently win.
  if (activePane !== 'paste') data.delete('markdown');
  if (activePane !== 'upload') data.delete('file');
  if (activePane !== 'web') {
    data.delete('urls');
    data.delete('karakeep');
    data.delete('karakeepLimit');
  } else {
    data.set('fromWeb', 'true');
    if (karakeepToggle.checked) data.delete('urls');
    else data.delete('karakeep');
  }
  if (!data.get('email')) data.delete('email');
  const cover = data.get('cover');
  if (cover && cover.size === 0) data.delete('cover');
  const file = data.get('file');
  if (file && file.size === 0) data.delete('file');
  if (!document.getElementById('typographer').checked) data.set('typographer', 'false');
  if (!document.getElementById('generateCover').checked) data.set('generateCover', 'false');
  // Explicit false, not a missing field: on a server where diagram rendering is
  // enabled, an absent field means "use the server default", which is on.
  if (!diagramsToggle.checked) data.set('renderDiagrams', 'false');
  if (!document.getElementById('embedRemoteImages').checked) data.delete('embedRemoteImages');
  return data;
}

function hasSource(data) {
  const file = data.get('file');
  const markdown = data.get('markdown');
  const urls = data.get('urls');
  return Boolean(
    (file && file.size > 0)
    || (markdown && String(markdown).trim())
    || (urls && String(urls).trim())
    || data.get('karakeep'),
  );
}

async function errorFrom(response) {
  try {
    const body = await response.json();
    return body.error || `The server answered ${response.status}.`;
  } catch {
    return `The server answered ${response.status}.`;
  }
}

function warningsFrom(response) {
  const header = response.headers.get('X-Md2Epub-Warnings');
  if (!header) return [];
  try {
    return JSON.parse(decodeURIComponent(header));
  } catch {
    return [];
  }
}

function filenameFrom(response, fallback) {
  const header = response.headers.get('Content-Disposition') || '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : fallback;
}

async function withBusy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  document.body.classList.add('is-busy');
  try {
    await task();
  } catch (error) {
    report({ ok: false, title: 'That did not work', message: error.message });
  } finally {
    button.disabled = false;
    button.textContent = original;
    document.body.classList.remove('is-busy');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = buildFormData();
  if (!hasSource(data)) {
    report({ ok: false, title: 'Nothing to convert', message: 'Paste some Markdown, choose a file, or give a URL first.' });
    return;
  }
  withBusy(downloadBtn, 'Converting...', async () => {
    const response = await fetch('/api/convert', { method: 'POST', body: data });
    if (!response.ok) throw new Error(await errorFrom(response));
    const blob = await response.blob();
    const name = filenameFrom(response, 'book.epub');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const chapters = response.headers.get('X-Md2Epub-Chapters');
    const documents = response.headers.get('X-Md2Epub-Documents');
    const diagrams = Number(response.headers.get('X-Md2Epub-Diagrams') || 0);
    const from = documents && documents !== '1' ? ` from ${documents} documents` : '';
    const drawn = diagrams ? `, ${diagrams} diagram${diagrams === 1 ? '' : 's'} rendered` : '';
    report({
      ok: true,
      title: 'EPUB ready',
      message: `${name}, ${(blob.size / 1024).toFixed(1)} KB, ${chapters || '1'} chapter${chapters === '1' ? '' : 's'}${from}${drawn}. Check your downloads.`,
      warnings: warningsFrom(response),
    });
  });
});

emailBtn.addEventListener('click', () => {
  const data = buildFormData();
  if (!hasSource(data)) {
    report({ ok: false, title: 'Nothing to convert', message: 'Paste some Markdown, choose a file, or give a URL first.' });
    return;
  }
  const address = emailInput.value.trim();
  if (!address && !kindleDefault) {
    report({ ok: false, title: 'No address', message: 'Enter the email address to send the EPUB to.' });
    emailInput.focus();
    return;
  }
  // A blank address is sent as no field at all; the server chooses.
  if (address) data.set('email', address);
  else data.delete('email');
  withBusy(emailBtn, 'Sending...', async () => {
    const response = await fetch('/api/email', { method: 'POST', body: data });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `The server answered ${response.status}.`);
    report({
      ok: true,
      title: body.dryRun ? 'Dry run: message written to the outbox' : 'Sent',
      message: `${body.filename} (${(body.size / 1024).toFixed(1)} KB) ${body.dryRun ? 'was prepared for' : 'is on its way to'} ${body.to}.`,
      warnings: body.warnings || [],
    });
  });
});

// Ctrl/Cmd + Enter converts and downloads.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    form.requestSubmit();
  }
});

// Ask the server what it can do, and reflect that in the controls.
fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    if (health.email && health.email.configured) {
      emailStatus.textContent = health.email.transport === 'log'
        ? `Email is in dry run mode: ${health.email.describe}.`
        : `Email is configured: ${health.email.describe}.`;
      emailBtn.disabled = false;
      if (health.email.kindleDefault) {
        kindleDefault = true;
        emailInput.placeholder = 'blank sends to the configured Kindle';
        emailStatus.textContent += ' Leave the address blank to send to the configured Kindle.';
      }
    } else {
      emailStatus.textContent = 'This server has no SMTP configured, so email delivery is off. Downloads still work.';
      emailBtn.disabled = true;
      emailInput.disabled = true;
    }
    if (remoteImagesRow && !health.remoteImages) remoteImagesRow.hidden = true;
    // Left visible but disabled when the server cannot render: a control that
    // simply vanishes is worse than one that says why it is unavailable.
    // A browser holding a cached copy of an older page will not have these
    // elements. Throwing here would kill the whole capability handler and make
    // every control look broken, so each one is optional.
    if (webTab && !health.urls) webTab.hidden = true;
    if (karakeepRow && health.karakeep) {
      karakeepRow.hidden = false;
      karakeepLimitRow.hidden = false;
      karakeepNote.textContent = 'Newest first, skipping anything already sent.';
      karakeepToggle.addEventListener('change', () => {
        urlsInput.disabled = karakeepToggle.checked;
      });
    }
    if (diagramsRow && !health.diagrams) {
      diagramsToggle.checked = false;
      diagramsToggle.disabled = true;
      diagramsNote.textContent = health.diagramsUnavailable
        ? `Unavailable: ${health.diagramsUnavailable}.`
        : 'Unavailable on this server.';
    }
  })
  .catch(() => {
    emailStatus.textContent = 'Could not reach the server to check email delivery.';
  });
