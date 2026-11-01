'use strict';

function filterIndexEntries(entries, { query = '', lines = 'all', diagrams = 'all' } = {}) {
  const needle = query.trim().toLowerCase();
  return entries.filter(entry => entry.name.toLowerCase().includes(needle)
    && (lines === 'all' || Boolean(entry.hasLines) === (lines === 'yes'))
    && (diagrams === 'all' || Boolean(entry.hasDiagrams) === (diagrams === 'yes')));
}

function buildIndexTree(entries) {
  const roots = new Map();
  const directories = new Map();
  for (const entry of entries) {
    if (!roots.has(entry.root)) {
      const root = { type: 'root', root: entry.root, name: entry.rootName, path: '', children: [] };
      roots.set(entry.root, root);
      directories.set(JSON.stringify([entry.root, '']), root);
    }
    let parent = roots.get(entry.root);
    const parts = entry.relativePath.split('/');
    let path = '';
    for (const part of parts.slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      const key = JSON.stringify([entry.root, path]);
      if (!directories.has(key)) {
        const directory = { type: 'directory', root: entry.root, name: part, path, children: [] };
        directories.set(key, directory);
        parent.children.push(directory);
      }
      parent = directories.get(key);
    }
    parent.children.push({ type: 'file', root: entry.root, name: entry.name, path: entry.relativePath, entry });
  }
  return Array.from(roots.values());
}

function renderIndexPage(nonce, language, labels) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const scriptData = JSON.stringify(labels).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const safeNonce = String(nonce).replace(/[^a-zA-Z0-9+/_=-]/g, '');
  const options = ['all', 'yes', 'no'].map(value => `<option value="${value}">${escape(labels[value])}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="${escape(language)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}';">
<title>${escape(labels.title)}</title>
<style nonce="${safeNonce}">
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px; }
h1 { font-size: 1.2em; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
label { display: flex; flex-direction: column; gap: 4px; }
.search { flex: 1; min-width: 140px; }
input, select { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 5px; font: inherit; }
button { font: inherit; cursor: pointer; }
#refresh { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 10px; }
#refresh:hover { background: var(--vscode-button-hoverBackground); }
.open { color: var(--vscode-textLink-foreground); background: transparent; border: 0; text-align: left; padding: 2px 4px; overflow-wrap: anywhere; }
.open:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
details { margin: 5px 0; }
summary { cursor: pointer; overflow-wrap: anywhere; }
.children { margin-left: 16px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--vscode-panel-border)); padding-left: 8px; }
.category-empty, #count, #status { color: var(--vscode-descriptionForeground); }
.items { display: flex; flex-direction: column; align-items: start; margin-left: 16px; }
.category-empty { margin: 5px 0 5px 16px; }
</style>
</head>
<body>
<h1>${escape(labels.title)}</h1>
<div class="toolbar">
<label class="search">${escape(labels.search)}<input id="query" type="search" placeholder="${escape(labels.search)}"></label>
<label>${escape(labels.lines)}<select id="lines">${options}</select></label>
<label>${escape(labels.diagrams)}<select id="diagrams">${options}</select></label>
<button id="refresh" type="button">${escape(labels.refresh)}</button>
</div>
<p id="count" aria-live="polite"></p>
<p id="status" role="status">${escape(labels.loading)}</p>
<div id="tree"></div>
<script nonce="${safeNonce}">
'use strict';
const filterIndexEntries = ${filterIndexEntries.toString()};
const buildIndexTree = ${buildIndexTree.toString()};
const labels = ${scriptData};
const ducktorApi = acquireVsCodeApi();
const saved = ducktorApi.getState() || {};
const state = {
  query: typeof saved.query === 'string' ? saved.query : '',
  lines: ['all', 'yes', 'no'].includes(saved.lines) ? saved.lines : 'all',
  diagrams: ['all', 'yes', 'no'].includes(saved.diagrams) ? saved.diagrams : 'all',
  expanded: saved.expanded && typeof saved.expanded === 'object' ? saved.expanded : {}
};
let entries = [];
let revision;
let loaded = false;
const query = document.getElementById('query');
const lines = document.getElementById('lines');
const diagrams = document.getElementById('diagrams');
const tree = document.getElementById('tree');
const count = document.getElementById('count');
const status = document.getElementById('status');
query.value = state.query;
lines.value = state.lines;
diagrams.value = state.diagrams;
function persist() { ducktorApi.setState(state); }
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function openButton(text, id) {
  const button = element('button', text, 'open');
  button.type = 'button';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    ducktorApi.postMessage({ action: 'open', revision, id });
  });
  return button;
}
function disclosure(key, heading, initiallyOpen) {
  const details = element('details');
  details.open = Object.prototype.hasOwnProperty.call(state.expanded, key) ? Boolean(state.expanded[key]) : initiallyOpen;
  const summary = element('summary');
  summary.append(heading);
  details.append(summary);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    state.expanded[key] = details.open;
    persist();
  });
  return details;
}
function lineLabel(line) { return String(labels.line).replace(/\\{line\\}/g, String(line)); }
function category(file, kind, label, items) {
  const heading = label + ' (' + items.length + ')';
  if (!items.length) return element('p', heading, 'category-empty');
  const key = JSON.stringify([file.root, file.path, kind]);
  const details = disclosure(key, element('span', heading), false);
  const list = element('div', undefined, 'items');
  for (const item of items) {
    let text;
    if (kind === 'lines') text = lineLabel(item.line) + (item.title ? ' — ' + item.title : '');
    else if (kind === 'blocks') text = item.title + ' (' + lineLabel(item.start) + '–' + item.end + ')';
    else text = item.symbol + ' (' + lineLabel(item.line) + ')';
    list.append(openButton(text, item.id));
  }
  details.append(list);
  return details;
}
function renderNode(node) {
  const key = JSON.stringify([node.root, node.path, node.type]);
  if (node.type === 'file') {
    const details = disclosure(key, openButton(node.name, node.entry.id), true);
    const children = element('div', undefined, 'children');
    children.append(
      category(node, 'lines', labels.lines, node.entry.lines),
      category(node, 'blocks', labels.blocks, node.entry.blocks),
      category(node, 'terms', labels.terms, node.entry.terms)
    );
    details.append(children);
    return details;
  }
  const heading = element('span', node.name);
  if (node.type === 'root') heading.title = node.root;
  const details = disclosure(key, heading, true);
  const children = element('div', undefined, 'children');
  for (const child of node.children) children.append(renderNode(child));
  details.append(children);
  return details;
}
function render() {
  if (!loaded) return;
  const filtered = filterIndexEntries(entries, state);
  count.textContent = labels.files.split('{count}').join(String(filtered.length)) + ' / ' + entries.length;
  status.textContent = filtered.length ? '' : labels.empty;
  status.hidden = filtered.length > 0;
  tree.replaceChildren(...buildIndexTree(filtered).map(renderNode));
}
function updateFilters() {
  state.query = query.value;
  state.lines = lines.value;
  state.diagrams = diagrams.value;
  persist();
  render();
}
query.addEventListener('input', updateFilters);
lines.addEventListener('change', updateFilters);
diagrams.addEventListener('change', updateFilters);
document.getElementById('refresh').addEventListener('click', () => ducktorApi.postMessage({ action: 'refresh' }));
window.addEventListener('message', event => {
  if (event.data.type !== 'index') return;
  entries = event.data.entries;
  revision = event.data.revision;
  loaded = true;
  render();
});
ducktorApi.postMessage({ action: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { filterIndexEntries, buildIndexTree, renderIndexPage };
