'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { parseDucktor, resolveBlock, resolveFileTarget, isWithin, explanationFile, codeFile, findTermMatches } = require('./core');
const { COMMANDS, commandLink, renderMarkdown, renderPanelMarkdown, escapeHtml, renderSourceLines } = require('./rendering');
const { randomBytes } = require('node:crypto');
const { translate } = require('./localization');

function t(key, values) {
  return translate(vscode.workspace.getConfiguration('ducktor').get('language', 'en'), key, values);
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Ducktor');
  const diagnostics = vscode.languages.createDiagnosticCollection('ducktor');
  const cache = new Map();
  const roots = () => (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  const sourceUri = document => {
    const file = explanationFile(document.uri.fsPath, roots());
    return file ? vscode.Uri.file(file) : undefined;
  };
  let generation = 0;
  const hintsChanged = new vscode.EventEmitter();
  const termDecoration = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline dotted', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  const blockDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
    light: { backgroundColor: 'rgba(65, 130, 210, 0.12)' },
    dark: { backgroundColor: 'rgba(90, 160, 240, 0.16)' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  let temporaryHighlight;
  let panelHighlight;
  let highlightRevision = 0;
  let openingHighlights = 0;
  let globalTerms;
  const termResults = new Map();
  const sideState = { panel: undefined, target: undefined, revision: 0, request: 0, links: new Map(), lines: new Map() };
  const lineState = { panel: undefined, target: undefined, revision: 0, request: 0, links: new Map(), lines: new Map() };
  function updatePanels(file) {
    for (const [state, standalone] of [[sideState, false], [lineState, true]]) {
      if (state.target && (file === undefined || state.target.file === file)) {
        updatePanel(state, standalone).catch(error => output.appendLine(t('panelUpdateFailed', { error: error.message })));
      }
    }
  }
  const refresh = () => {
    generation++; cache.clear(); globalTerms = undefined; termResults.clear(); diagnostics.clear(); hintsChanged.fire();
    clearTemporaryHighlight();
    panelHighlight = undefined;
    applyBlockHighlight();
    updateDecorations();
    updatePanels();
  };

  async function safeFile(target, source, explanation = false) {
    const original = codeFile(source, roots());
    if (!original) return undefined;
    const resolved = resolveFileTarget(target, explanation ? source : original, roots());
    if (explanation && resolved?.file !== source) return undefined;
    if (!resolved) return undefined;
    try {
      const real = await fs.realpath(resolved.file);
      const realRoots = await Promise.all(roots().map(root => fs.realpath(root)));
      if (!realRoots.some(root => isWithin(root, real))) return undefined;
      return resolved;
    } catch { return undefined; }
  }

  async function deleteExplanations(uris) {
    if (!uris.length) return;
    const edit = new vscode.WorkspaceEdit();
    for (const uri of uris) edit.deleteFile(uri, { ignoreIfNotExists: true }, { needsConfirmation: false });
    if (await vscode.workspace.applyEdit(edit)) {
      refresh();
    } else {
      await vscode.window.showWarningMessage(t('deleteFailedWarning'));
    }
  }

  async function clear(args) {
    const active = vscode.window.activeTextEditor?.document;
    const source = args?.source || (active?.uri.scheme === 'file' && !active.uri.fsPath.endsWith('.ducktor') ? sourceUri(active)?.fsPath : undefined);
    if (typeof source !== 'string') return;
    try {
      const target = await safeFile(path.basename(source), source, true);
      if (!target) return;
      const uri = vscode.Uri.file(target.file);
      if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.File) return;
      await deleteExplanations([uri]);
    } catch (error) {
      await vscode.window.showErrorMessage(t('deleteFailed', { error: error.message }));
    }
  }

  async function clearAll() {
    try {
      // null 禁用默认排除规则，包含工作区内被 files.exclude 隐藏的解释文件。
      const found = await vscode.workspace.findFiles('**/.ducktor/**/*.ducktor', null);
      const uris = [];
      for (const uri of found) {
        if (uri.scheme !== 'file') continue;
        if (await safeFile(path.basename(uri.fsPath), uri.fsPath, true)) uris.push(uri);
      }
      if (!uris.length) {
        await vscode.window.showInformationMessage(t('noExplanationFiles'));
        return;
      }
      const deleteAllLabel = t('deleteAll');
      const choice = await vscode.window.showWarningMessage(
        t('confirmDeleteAll', { count: uris.length }),
        { modal: true, detail: t('deleteAllDetail') },
        deleteAllLabel
      );
      if (choice !== deleteAllLabel) return;
      await deleteExplanations(uris);
    } catch (error) {
      await vscode.window.showErrorMessage(t('deleteFailed', { error: error.message }));
    }
  }

  async function openFile(args) {
    if (!args || typeof args !== 'object') return;
    const target = await safeFile(args.target, args.source);
    if (!target) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      const options = {};
      if (target.start !== undefined) {
        const start = Math.min(target.start, document.lineCount - 1);
        const end = Math.min(target.end, document.lineCount - 1);
        options.selection = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
      }
      await vscode.window.showTextDocument(document, options);
    } catch (error) { output.appendLine(t('openFileFailed', { error: error.message })); }
  }

  const languageAliases = { ts: 'typescript', js: 'javascript', py: 'python', cpp: 'cpp', c: 'c', rs: 'rust', go: 'go' };
  async function findSymbols(name, language) {
    if (typeof name !== 'string' || !/^[\p{L}_$][\p{L}\p{N}_$.]*$/u.test(name)) return [];
    const short = name.split('.').pop();
    const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', short) || [];
    const found = [];
    for (const symbol of symbols) {
      if (symbol.name !== name && symbol.name !== short && `${symbol.containerName}.${symbol.name}` !== name) continue;
      if (name.includes('.') && symbol.name !== name && `${symbol.containerName}.${symbol.name}` !== name) continue;
      const uri = symbol.location.uri;
      if (uri.scheme !== 'file' || !roots().some(root => isWithin(root, uri.fsPath))) continue;
      if (language && (await vscode.workspace.openTextDocument(uri)).languageId !== (languageAliases[language] || language)) continue;
      found.push(symbol);
    }
    const preferred = found.filter(symbol => [vscode.SymbolKind.Function, vscode.SymbolKind.Class, vscode.SymbolKind.Method].includes(symbol.kind));
    return preferred.length ? preferred : found;
  }

  async function openSymbol(args) {
    if (!args || typeof args.name !== 'string' || (args.language !== undefined && typeof args.language !== 'string')) return;
    try {
      const symbols = await findSymbols(args.name, args.language);
      const selected = symbols.length === 1 ? symbols[0] : await vscode.window.showQuickPick(symbols.map(symbol => ({ label: symbol.name, description: vscode.workspace.asRelativePath(symbol.location.uri), symbol }))).then(item => item?.symbol);
      if (selected) {
        const document = await vscode.workspace.openTextDocument(selected.location.uri);
        await vscode.window.showTextDocument(document, { selection: selected.location.range });
      }
    } catch (error) { output.appendLine(t('openSymbolFailed', { error: error.message })); }
  }

  async function openExternal(args) {
    if (!args || typeof args.url !== 'string') return;
    try {
      const url = new URL(args.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') await vscode.env.openExternal(vscode.Uri.parse(url.href));
    } catch { /* 非 URL 目标不会执行。 */ }
  }

  async function load(document) {
    const uri = sourceUri(document);
    return uri && await safeFile(path.basename(uri.fsPath), uri.fsPath, true) ? loadUri(uri) : { blocks: [], terms: [] };
  }

  async function loadUri(uri) {
    const key = uri.toString();
    if (cache.has(key)) return cache.get(key);
    const currentGeneration = generation;
    let source;
    const opened = vscode.workspace.textDocuments.find(item => item.uri.toString() === key);
    try { source = opened ? opened.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); }
    catch (error) {
      if (error.code !== 'FileNotFound' && error.code !== 'ENOENT') output.appendLine(t('readFileFailed', { file: uri.fsPath, error: error.message }));
      const empty = { blocks: [], terms: [] };
      if (currentGeneration === generation) cache.set(key, empty);
      return empty;
    }
    if (currentGeneration !== generation) return { blocks: [], terms: [] };
    try {
      const parsed = parseDucktor(source, vscode.workspace.getConfiguration('ducktor').get('language', 'en'));
      diagnostics.set(uri, parsed.errors.map(message => new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, vscode.DiagnosticSeverity.Warning)));
      cache.set(key, parsed);
      return parsed;
    } catch (error) {
      diagnostics.set(uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), error.message, vscode.DiagnosticSeverity.Error)]);
      const empty = { blocks: [], terms: [] };
      cache.set(key, empty);
      return empty;
    }
  }

  async function documentSymbols(document) {
    const items = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) || [];
    const types = { [vscode.SymbolKind.Function]: 'function', [vscode.SymbolKind.Class]: 'class', [vscode.SymbolKind.Struct]: 'class', [vscode.SymbolKind.Interface]: 'class', [vscode.SymbolKind.Method]: 'method', [vscode.SymbolKind.Constructor]: 'method', [vscode.SymbolKind.Variable]: 'variable', [vscode.SymbolKind.Field]: 'variable', [vscode.SymbolKind.Constant]: 'constant' };
    const result = [];
    function walk(symbols, container = '') {
      for (const symbol of symbols) {
        const range = symbol.selectionRange || symbol.location?.range || symbol.range;
        if (range) result.push({ name: symbol.name, container: symbol.containerName || container, type: types[symbol.kind], start: range.start.line });
        if (symbol.children) walk(symbol.children, container ? `${container}.${symbol.name}` : symbol.name);
      }
    }
    walk(items);
    return result;
  }

  async function resolveLink(target, shortcut, source, symbolCache) {
    if (/^https?:\/\//i.test(target)) {
      try { const url = new URL(target); return commandLink('ducktor.openExternal', [{ url: url.href }]); } catch { return undefined; }
    }
    if (target.startsWith('command:')) {
      // 仅支持无参数刷新命令，文件和符号命令的参数由插件生成。
      return target === 'command:ducktor.refresh' ? commandLink('ducktor.refresh', []) : undefined;
    }
    if (shortcut && /^[\p{L}_$][\p{L}\p{N}_$.]*(?::[\w+-]+)?$/u.test(target) && !/\.(?:[cm]?[jt]sx?|cpp|cc|c|h|hpp|py|rs|go|java|yaml|yml|json|md|txt|ducktor)$/i.test(target)) {
      const [name, language] = target.split(':');
      if (!symbolCache.has(target)) symbolCache.set(target, findSymbols(name, language).catch(() => []));
      if ((await symbolCache.get(target)).length) return commandLink('ducktor.openSymbol', [{ name, language }]);
    }
    if (await safeFile(target, source)) return commandLink('ducktor.openFile', [{ target, source }]);
    return undefined;
  }

  function enabled(document) {
    return document.uri.scheme === 'file' && !!sourceUri(document) &&
      !!vscode.workspace.getWorkspaceFolder(document.uri) && vscode.workspace.getConfiguration('ducktor', document.uri).get('enabled', true);
  }

  async function resolvedBlocks(document) {
    const { blocks } = await load(document);
    const needsSymbols = blocks.some(block => block.anchor && !['text', 'comment', 'hash'].includes(block.anchor.type));
    const symbols = needsSymbols ? await documentSymbols(document).catch(() => []) : [];
    const lines = document.getText().split(/\r?\n/);
    return blocks.map((block, index) => {
      const resolved = resolveBlock(block, lines, symbols);
      return resolved && { ...resolved, index };
    }).filter(Boolean);
  }

  async function workspaceTerms() {
    if (!globalTerms) globalTerms = (async () => {
      const found = await vscode.workspace.findFiles('**/.ducktor/**/*.ducktor', '**/node_modules/**');
      const terms = [];
      for (const uri of found.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
        if (uri.scheme !== 'file' || !await safeFile(path.basename(uri.fsPath), uri.fsPath, true)) continue;
        const parsed = await loadUri(uri);
        terms.push(...parsed.terms.filter(term => term.scope === 'global').map(term => ({ ...term, source: uri.fsPath })));
      }
      return terms;
    })();
    return globalTerms;
  }

  async function termMatches(document) {
    if (!enabled(document)) return [];
    const key = document.uri.toString();
    const previous = termResults.get(key);
    if (previous?.version === document.version && previous.generation === generation) return previous.promise;
    const promise = (async () => {
      const parsed = await load(document);
      const source = sourceUri(document).fsPath;
      const terms = parsed.terms.filter(term => term.scope !== 'global').map(term => ({ ...term, source }));
      const blocks = terms.some(term => term.scope === 'local') ? await resolvedBlocks(document) : [];
      const scoped = terms.flatMap(term => {
        if (term.scope !== 'local') return [term];
        const block = blocks.find(block => block.blockNumber === term.block);
        return block ? [{ ...term, localRange: { start: block.start, end: block.end } }] : [];
      });
      const root = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath;
      const global = (await workspaceTerms()).filter(term => isWithin(root, term.source));
      return findTermMatches(document.getText().split(/\r?\n/), [...scoped, ...global]);
    })();
    termResults.set(key, { version: document.version, generation, promise });
    return promise;
  }

  function updateDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      const version = editor.document.version;
      const currentGeneration = generation;
      editor.setDecorations(termDecoration, []);
      termMatches(editor.document).then(matches => {
        if (version !== editor.document.version || currentGeneration !== generation) return;
        editor.setDecorations(termDecoration, matches.map(match => new vscode.Range(match.line, match.start, match.line, match.end)));
      }).catch(error => output.appendLine(t('termDecorationFailed', { error: error.message })));
    }
  }

  function applyBlockHighlight() {
    const target = temporaryHighlight || (sideState.panel?.visible ? panelHighlight : undefined);
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = target?.file === editor.document.uri.fsPath && enabled(editor.document)
        ? target.ranges.map(range => new vscode.Range(range.start, 0, range.end, editor.document.lineAt(range.end).text.length)) : [];
      editor.setDecorations(blockDecoration, ranges);
    }
  }

  function clearTemporaryHighlight() {
    highlightRevision++;
    temporaryHighlight = undefined;
    applyBlockHighlight();
  }

  async function highlightBlock(args) {
    if (!args || typeof args.file !== 'string' || !Number.isInteger(args.index) || (args.line !== undefined && !Number.isInteger(args.line)) || !roots().some(root => isWithin(root, args.file))) return;
    const revision = ++highlightRevision;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(args.file));
    if (!enabled(document)) return;
    const version = document.version;
    const currentGeneration = generation;
    const blocks = await resolvedBlocks(document);
    const selected = blocks.find(block => block.index === args.index);
    if (!selected || revision !== highlightRevision || version !== document.version || currentGeneration !== generation) return;
    if (args.line !== undefined && !(selected.lineExplanations || []).some(item => item.line === args.line)) return;
    let editor;
    openingHighlights++;
    try {
      const visibleEditor = vscode.window.visibleTextEditors.find(item => item.document.uri.fsPath === args.file);
      editor = await vscode.window.showTextDocument(document, { preserveFocus: false, viewColumn: visibleEditor?.viewColumn });
    }
    finally { openingHighlights--; }
    if (revision !== highlightRevision || version !== document.version || currentGeneration !== generation) return;
    const start = args.line === undefined ? selected.start : args.line;
    const end = args.line === undefined ? selected.end : args.line;
    temporaryHighlight = { file: args.file, ranges: args.line === undefined
      ? blocks.filter(block => block.start === selected.start).map(block => ({ start: block.start, end: block.end }))
      : [{ start, end }] };
    applyBlockHighlight();
    editor.revealRange(new vscode.Range(start, 0, end, document.lineAt(end).text.length), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async function termMarkdown(term, hover = false) {
    return renderMarkdown(term.content, (target, shortcut) => resolveLink(target, shortcut, term.source, new Map()), { hover });
  }

  async function blockMarkdown(document, blocks, hover = false) {
    const symbolCache = new Map();
    const values = [];
    for (const block of blocks) {
      const value = await renderMarkdown(block.content, (target, shortcut) => resolveLink(target, shortcut, sourceUri(document).fsPath, symbolCache), { hover });
      values.push(value + (block.drifted ? `\n\n> ${t('driftWarning')}` : ''));
    }
    return values.join('\n\n---\n\n');
  }

  async function updatePanel(state, standalone) {
    if (!state.panel || !state.target) return;
    const revision = ++state.revision;
    const currentPanel = state.panel;
    const target = state.target;
    const currentGeneration = generation;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
    const version = document.version;
    const blocks = enabled(document) ? await resolvedBlocks(document) : [];
    const selected = standalone ? undefined : blocks.find(block => block.index === target.index);
    const matched = standalone ? blocks.filter(block => block.lineExplanations?.length) : selected ? blocks.filter(block => block.start === selected.start) : [];
    const term = target.termSource && enabled(document) ? (await termMatches(document)).map(match => match.term).find(term => term.source === target.termSource && term.index === target.termIndex) : undefined;
    const markdown = target.termSource ? (term ? await termMarkdown(term) : '') : await blockMarkdown(document, matched);
    const links = new Map();
    const lines = new Map();
    const overview = markdown ? renderPanelMarkdown(markdown, links) : `<p>${escapeHtml(t('noExplanation'))}</p>`;
    const aligned = standalone;
    let content = '';
    if (aligned) {
      const sourceLines = renderSourceLines(document.getText(), document.languageId);
      const symbolCache = new Map();
      const entries = new Map();
      for (const block of matched) {
        for (const item of block.lineExplanations || []) {
          const explanation = await renderMarkdown(item.content, (target, shortcut) => resolveLink(target, shortcut, sourceUri(document).fsPath, symbolCache), { heading: false });
          const html = renderPanelMarkdown(explanation, links);
          const id = String(lines.size);
          lines.set(id, { file: target.file, index: block.index, line: item.line });
          if (!entries.has(item.line)) entries.set(item.line, []);
          entries.get(item.line).push(`<section class="line-explanation"><button class="jump-line" data-line="${id}">${escapeHtml(t('line', { line: item.line + 1 }))}</button>${html}</section>`);
        }
      }
      content = `<div id="line-grid" aria-label="${escapeHtml(t('lineExplanations'))}"><div class="column-head"><span>${escapeHtml(t('sourceCode'))}</span><span>${escapeHtml(t('lineExplanations'))}</span></div>${Array.from({ length: document.lineCount }, (_, line) => `<div class="source-row${matched.some(block => line >= block.start && line <= block.end) ? ' selected' : ''}" data-source-line="${line}"><div class="source-cell"><button class="line-number" data-source="${line}" title="${escapeHtml(t('openSource'))}">${line + 1}</button><code class="source-code">${sourceLines[line]}</code></div><div class="row-content">${(entries.get(line) || []).join('')}</div></div>`).join('')}</div>`;
    }
    const config = vscode.workspace.getConfiguration('editor', document.uri);
    const fontSize = config.get('fontSize', 14);
    const configuredHeight = config.get('lineHeight', 0);
    const lineHeight = Math.max(8, Math.round(configuredHeight === 0 ? fontSize * 1.5 : configuredHeight < 8 ? fontSize * configuredHeight : configuredHeight));
    if (revision !== state.revision || state.panel !== currentPanel || state.target !== target || version !== document.version || currentGeneration !== generation) return;
    if (!standalone) {
      panelHighlight = !target.termSource && matched.length ? { file: target.file, ranges: matched.map(block => ({ start: block.start, end: block.end })) } : undefined;
      applyBlockHighlight();
    }
    state.links = links;
    state.lines = lines;
    const nonce = randomBytes(16).toString('hex');
    currentPanel.title = standalone ? `Ducktor: ${path.basename(target.file)}` : t('panelTitle');
    const language = vscode.workspace.getConfiguration('ducktor').get('language', 'en') === 'zh-CN' ? 'zh-CN' : 'en';
    const initialMode = aligned && lines.size ? 'lines' : 'overview';
    currentPanel.webview.html = `<!DOCTYPE html><html lang="${language}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;overflow:hidden;font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);--preview-font-size:${fontSize}px;--row-height:${lineHeight}px}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;min-height:50px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
header span{flex:1;min-width:100px}nav{display:flex;gap:4px}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 9px;cursor:pointer;font:inherit}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}nav button{background:transparent;color:var(--vscode-editor-foreground)}nav button[aria-selected="true"]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}a{color:var(--vscode-textLink-foreground)}
body{display:flex;flex-direction:column;height:100vh}main{flex:1;min-height:0;overflow:auto;overflow-anchor:none}#overview{padding:24px 32px;max-width:1100px;margin:0 auto;line-height:1.6;overflow-wrap:anywhere}
.ducktor-color-red{color:#f14c4c}.ducktor-color-blue{color:#3794ff}.ducktor-color-green{color:#73c991}.ducktor-color-orange{color:#e99547}.ducktor-color-yellow{color:#d7ba7d}.ducktor-color-gray{color:#999}.vscode-light .ducktor-color-red{color:#c62828}.vscode-light .ducktor-color-blue{color:#005fb8}.vscode-light .ducktor-color-green{color:#287d38}.vscode-light .ducktor-color-orange{color:#a65300}.vscode-light .ducktor-color-yellow{color:#806600}.vscode-light .ducktor-color-gray{color:#666}.ducktor-underline{text-decoration:underline}
pre{background:var(--vscode-textCodeBlock-background);padding:12px;overflow:auto}code{font-family:var(--vscode-editor-font-family)}blockquote{border-left:3px solid var(--vscode-textBlockQuote-border);margin-left:0;padding-left:12px}h1,h2,h3,h4{line-height:1.3}[hidden]{display:none!important}
#line-grid{font-family:var(--vscode-editor-font-family);font-weight:var(--vscode-editor-font-weight);font-size:var(--preview-font-size);line-height:var(--row-height);padding-bottom:24px}
.source-row,.column-head{display:grid;grid-template-columns:minmax(0,var(--source-ratio,50%)) minmax(0,1fr)}.source-row{min-height:var(--row-height)}
#lines{position:relative}#splitter{position:absolute;top:0;bottom:0;left:var(--source-ratio,50%);width:9px;transform:translateX(-50%);z-index:2;cursor:col-resize;touch-action:none;background:transparent}#splitter:hover,#splitter:focus-visible{background:var(--vscode-focusBorder);outline:0;opacity:.6}body.resizing{cursor:col-resize;user-select:none}
.column-head{position:sticky;top:0;z-index:1;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);font-family:var(--vscode-font-family);font-size:12px;font-weight:normal}.column-head span{padding:8px 12px}.column-head span+span{border-left:1px solid var(--vscode-panel-border)}
.source-cell{display:flex;align-items:flex-start;min-width:0;padding:0 12px 0 0}.line-number{flex:0 0 54px;text-align:right;padding:0 12px 0 0;background:transparent;color:var(--vscode-editorLineNumber-foreground);line-height:var(--row-height)}.source-code{display:block;background:transparent;padding:0;border:0;border-radius:0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:${config.get('tabSize', 4)};font:inherit}
.source-code{--syntax-keyword:#569cd6;--syntax-string:#ce9178;--syntax-number:#b5cea8;--syntax-comment:#6a9955;--syntax-title:#dcdcaa;--syntax-type:#4ec9b0;--syntax-variable:#9cdcfe}.vscode-light .source-code{--syntax-keyword:#0000ff;--syntax-string:#a31515;--syntax-number:#098658;--syntax-comment:#008000;--syntax-title:#795e26;--syntax-type:#267f99;--syntax-variable:#001080}.source-code .hljs-keyword,.source-code .hljs-selector-tag,.source-code .hljs-literal{color:var(--syntax-keyword)}.source-code .hljs-string,.source-code .hljs-regexp{color:var(--syntax-string)}.source-code .hljs-number{color:var(--syntax-number)}.source-code .hljs-comment,.source-code .hljs-quote{color:var(--syntax-comment)}.source-code .hljs-title{color:var(--syntax-title)}.source-code .hljs-type,.source-code .hljs-built_in,.source-code .hljs-title.class_{color:var(--syntax-type)}.source-code .hljs-variable,.source-code .hljs-attr,.source-code .hljs-attribute,.source-code .hljs-params,.source-code .hljs-property{color:var(--syntax-variable)}.source-code .hljs-tag,.source-code .hljs-name,.source-code .hljs-meta{color:var(--syntax-keyword)}
.row-content{min-width:0;border-left:1px solid var(--vscode-panel-border);padding:0 12px;overflow-wrap:anywhere}.line-explanation p{margin:0}.line-explanation pre{margin:0;padding:8px}.line-explanation ul,.line-explanation ol{margin:0;padding-left:24px}.line-explanation h1,.line-explanation h2,.line-explanation h3,.line-explanation h4{font-size:1em;margin:0;line-height:inherit}.line-explanation blockquote{margin:0}.line-explanation+.line-explanation{margin-top:8px}.jump-line{float:right;margin-left:8px;background:transparent;color:var(--vscode-textLink-foreground);font-size:11px;line-height:var(--row-height);padding:0}
</style></head><body><header><span>${escapeHtml(path.basename(document.uri.fsPath))}${term ? ` · ${escapeHtml(term.symbol)}` : selected ? ` · ${escapeHtml(t('line', { line: selected.start + 1 }))}` : ''}</span>${aligned ? `<nav role="tablist" aria-label="${escapeHtml(t('panelTitle'))}"><button role="tab" data-mode="overview" aria-controls="overview" aria-selected="${initialMode === 'overview'}">${escapeHtml(t('blockOverview'))}</button><button role="tab" data-mode="lines" aria-controls="lines" aria-selected="${initialMode === 'lines'}">${escapeHtml(t('lineExplanations'))}</button></nav>` : ''}<button data-action="clear">${escapeHtml(t('clear'))}</button><button data-action="clearAll">${escapeHtml(t('clearAll'))}</button></header><main><section id="overview"${initialMode !== 'overview' ? ' hidden' : ''}>${overview}</section>${aligned ? `<section id="lines"${initialMode !== 'lines' ? ' hidden' : ''}>${content}<div id="splitter" role="separator" aria-label="${language === 'zh-CN' ? '调整左右列宽' : 'Resize columns'}" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50" tabindex="0"></div></section>` : ''}</main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const revision=${revision};const main=document.querySelector('main');const identity=${JSON.stringify(`${target.file}:${standalone ? 'lines' : `${target.termSource || ''}:${target.termIndex ?? target.index}`}`).replace(/</g, '\\u003c')};const initialMode=${JSON.stringify(initialMode)};const saved=vscode.getState();let mode=initialMode;const positions={overview:0,lines:0};
const splitter=document.getElementById('splitter');let ratio=saved&&Number.isFinite(saved.ratio)?Math.max(20,Math.min(80,saved.ratio)):50;
function save(){positions[mode]=main.scrollTop;vscode.setState({identity,mode,positions,ratio});}
function resize(value){ratio=Math.max(20,Math.min(80,value));document.getElementById('lines').style.setProperty('--source-ratio',ratio+'%');splitter.setAttribute('aria-valuenow',String(Math.round(ratio)));save();}
if(splitter){resize(ratio);let pointer;splitter.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();pointer=event.pointerId;splitter.setPointerCapture(pointer);document.body.classList.add('resizing');});splitter.addEventListener('pointermove',event=>{if(event.pointerId!==pointer)return;const bounds=document.getElementById('line-grid').getBoundingClientRect();if(bounds.width)resize((event.clientX-bounds.left)/bounds.width*100);});const finish=()=>{pointer=undefined;document.body.classList.remove('resizing');save();};splitter.addEventListener('pointerup',finish);splitter.addEventListener('pointercancel',finish);splitter.addEventListener('lostpointercapture',finish);splitter.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'||event.key==='Home'){event.preventDefault();resize(event.key==='Home'?50:ratio+(event.key==='ArrowLeft'?-2:2));}});}
function switchMode(next,remember=true){if(!document.getElementById(next))return;if(remember)positions[mode]=main.scrollTop;mode=next;document.getElementById('overview').hidden=mode!=='overview';const lines=document.getElementById('lines');if(lines)lines.hidden=mode!=='lines';document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.mode===mode)));main.scrollTop=positions[mode];save();}
if(saved&&saved.identity===identity){Object.assign(positions,saved.positions);switchMode(saved.mode,false);}else{switchMode(initialMode);if(initialMode==='lines'){const row=document.querySelector('[data-source-line="${matched[0]?.start || 0}"]');if(row)main.scrollTop=Math.max(0,row.offsetTop-48);save();}}
main.addEventListener('scroll',save);
document.addEventListener('click',event=>{const element=event.target.closest('[data-action],[data-link],[data-line],[data-source],[data-mode]');if(!element)return;event.preventDefault();if(element.dataset.mode){switchMode(element.dataset.mode);return;}vscode.postMessage({revision,action:element.dataset.action,link:element.dataset.link,line:element.dataset.line,sourceLine:element.dataset.source===undefined?undefined:Number(element.dataset.source)});});
</script></body></html>`;
  }

  async function openPanel(state, standalone, target) {
    state.target = target;
    state.revision++;
    const viewColumn = standalone ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    if (!state.panel) {
      const panel = vscode.window.createWebviewPanel(standalone ? 'ducktor.lineExplanation' : 'ducktor.explanation', standalone ? `Ducktor: ${path.basename(target.file)}` : t('panelTitle'), { viewColumn, preserveFocus: !standalone }, { enableScripts: true, localResourceRoots: [] });
      state.panel = panel;
      context.subscriptions.push(panel, panel.onDidDispose(() => {
        state.panel = undefined; state.target = undefined; state.links.clear(); state.lines.clear(); state.revision++; state.request++;
        if (!standalone) { panelHighlight = undefined; applyBlockHighlight(); }
      }), panel.onDidChangeViewState(() => { if (!standalone) applyBlockHighlight(); }),
        panel.webview.onDidReceiveMessage(async message => {
          if (!message || message.revision !== state.revision || state.panel !== panel || !state.target) return;
          const target = state.target;
          try {
            if (standalone && Number.isInteger(message.sourceLine)) {
              const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
              if (message.revision !== state.revision || state.panel !== panel || state.target !== target || !enabled(document) || message.sourceLine < 0 || message.sourceLine >= document.lineCount) return;
              await vscode.window.showTextDocument(document, { selection: new vscode.Range(message.sourceLine, 0, message.sourceLine, document.lineAt(message.sourceLine).text.length) });
            }
            else if (standalone && typeof message.line === 'string' && state.lines.has(message.line)) await highlightBlock(state.lines.get(message.line));
            else if (message.action === 'clear') await clear({ source: target.termSource || sourceUri({ uri: vscode.Uri.file(target.file) })?.fsPath });
            else if (message.action === 'clearAll') await clearAll();
            else if (typeof message.link === 'string' && state.links.has(message.link)) {
              const uri = vscode.Uri.parse(state.links.get(message.link));
              if (COMMANDS.includes(uri.path)) await vscode.commands.executeCommand(uri.path, ...JSON.parse(decodeURIComponent(uri.query)));
            }
          } catch (error) { output.appendLine(t('panelActionFailed', { error: error.message })); }
        }));
    } else state.panel.reveal(viewColumn, !standalone);
    await updatePanel(state, standalone);
  }

  async function showExplanation(args) {
    const request = ++sideState.request;
    const currentGeneration = generation;
    if (args === undefined) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !enabled(editor.document)) return;
      const version = editor.document.version;
      const line = editor.selection.active.line;
      const blocks = await resolvedBlocks(editor.document);
      if (request !== sideState.request || version !== editor.document.version || currentGeneration !== generation) return;
      const block = blocks.find(item => !item.range.all && line >= item.start && line <= item.end) || blocks.find(item => line >= item.start && line <= item.end);
      if (!block) return;
      args = { file: editor.document.uri.fsPath, index: block.index };
    }
    if (!args || typeof args.file !== 'string' || (!Number.isInteger(args.index) && !(typeof args.termSource === 'string' && Number.isInteger(args.termIndex)))) return;
    if (!roots().some(root => isWithin(root, args.file))) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(args.file));
    if (!enabled(document) || request !== sideState.request || currentGeneration !== generation) return;
    panelHighlight = undefined;
    clearTemporaryHighlight();
    await openPanel(sideState, false, { file: args.file, index: args.index, termSource: args.termSource, termIndex: args.termIndex });
  }

  async function showLineExplanation(args) {
    const file = args === undefined ? vscode.window.activeTextEditor?.document.uri.fsPath : typeof args === 'string' ? args : args?.file;
    if (typeof file !== 'string' || !roots().some(root => isWithin(root, file))) return;
    const request = ++lineState.request;
    const currentGeneration = generation;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (!enabled(document)) return;
    const version = document.version;
    const blocks = await resolvedBlocks(document);
    if (request !== lineState.request || version !== document.version || currentGeneration !== generation || !enabled(document) || !blocks.some(block => block.lineExplanations?.length)) return;
    await openPanel(lineState, true, { file });
  }

  context.subscriptions.push(output, diagnostics, hintsChanged, termDecoration, blockDecoration,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      async provideHover(document, position, token) {
        if (!enabled(document)) return;
        try {
          const version = document.version;
          const currentGeneration = generation;
          const match = (await termMatches(document)).find(match => match.line === position.line && position.character >= match.start && position.character < match.end);
          if (!match || token.isCancellationRequested) return;
          const args = { file: document.uri.fsPath, termSource: match.term.source, termIndex: match.term.index };
          const mode = vscode.workspace.getConfiguration('ducktor', document.uri).get('displayMode', 'hover');
          const entry = `[${t('viewTermExplanation')}](${commandLink('ducktor.showExplanation', [args])})`;
          const markdown = new vscode.MarkdownString(mode === 'panel' ? entry : `${entry}\n\n---\n\n${await termMarkdown(match.term, true)}`);
          markdown.isTrusted = { enabledCommands: [...COMMANDS, 'ducktor.showExplanation'] };
          markdown.supportHtml = false;
          if (token.isCancellationRequested || version !== document.version || currentGeneration !== generation) return;
          return new vscode.Hover(markdown, new vscode.Range(match.line, match.start, match.line, match.end));
        } catch (error) { output.appendLine(t('termExplanationFailed', { error: error.message })); }
      }
    }),
    vscode.commands.registerCommand('ducktor.refresh', refresh),
    vscode.commands.registerCommand('ducktor.clear', clear),
    vscode.commands.registerCommand('ducktor.clearAll', clearAll),
    vscode.commands.registerCommand('ducktor.openFile', openFile),
    vscode.commands.registerCommand('ducktor.openSymbol', openSymbol),
    vscode.commands.registerCommand('ducktor.openExternal', openExternal),
    vscode.commands.registerCommand('ducktor.showExplanation', showExplanation),
    vscode.commands.registerCommand('ducktor.showLineExplanation', showLineExplanation),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
      onDidChangeCodeLenses: hintsChanged.event,
      async provideCodeLenses(document, token) {
        if (token.isCancellationRequested || !enabled(document)) return [];
        try {
          const version = document.version;
          const currentGeneration = generation;
          const blocks = await resolvedBlocks(document);
          if (token.isCancellationRequested || version !== document.version || currentGeneration !== generation || !enabled(document) || !blocks.some(block => block.lineExplanations?.length)) return [];
          return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
            title: '📖逐行解释', command: 'ducktor.showLineExplanation', arguments: [{ file: document.uri.fsPath }]
          })];
        } catch (error) { output.appendLine(t('inlayExplanationFailed', { error: error.message })); return []; }
      }
    }),
    vscode.commands.registerCommand('ducktor.highlightBlock', highlightBlock),
    vscode.languages.registerInlayHintsProvider({ scheme: 'file' }, {
      onDidChangeInlayHints: hintsChanged.event,
      async provideInlayHints(document, range, token) {
        if (!enabled(document)) return [];
        try {
          const version = document.version;
          const currentGeneration = generation;
          const blocks = await resolvedBlocks(document);
          const groups = new Map();
          for (const block of blocks) {
            if (block.start < range.start.line || block.start > range.end.line) continue;
            if (!groups.has(block.start)) groups.set(block.start, []);
            groups.get(block.start).push(block);
          }
          const hints = [];
          for (const [line, matched] of groups) {
            if (token.isCancellationRequested) return [];
            const part = new vscode.InlayHintLabelPart('📝 Ducktor');
            const args = { file: document.uri.fsPath, index: matched[0].index };
            part.command = { title: t('showExplanation'), command: 'ducktor.showExplanation', arguments: [args] };
            const mode = vscode.workspace.getConfiguration('ducktor', document.uri).get('displayMode', 'hover');
            const entry = `[${t('highlightBlock')}](${commandLink('ducktor.highlightBlock', [args])}) · [${t('openPanel')}](${commandLink('ducktor.showExplanation', [args])}) · [${t('clear')}](${commandLink('ducktor.clear', [{ source: sourceUri(document).fsPath }])}) · [${t('clearAll')}](${commandLink('ducktor.clearAll', [])})`;
            const value = mode === 'panel' ? `[${t('viewExplanation')}](${commandLink('ducktor.showExplanation', [args])})\n\n${t('inlayClickHint')}` :
              `${entry}\n\n---\n\n${await blockMarkdown(document, matched, true)}`;
            part.tooltip = new vscode.MarkdownString(value);
            part.tooltip.isTrusted = { enabledCommands: [...COMMANDS, 'ducktor.showExplanation', 'ducktor.highlightBlock', 'ducktor.clear', 'ducktor.clearAll'] };
            part.tooltip.supportHtml = false;
            const hint = new vscode.InlayHint(new vscode.Position(line, document.lineAt(line).text.length), [part]);
            hint.paddingLeft = true;
            hints.push(hint);
          }
          return token.isCancellationRequested || version !== document.version || currentGeneration !== generation ? [] : hints;
        } catch (error) { output.appendLine(t('inlayExplanationFailed', { error: error.message })); return []; }
      }
    })
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/.ducktor/**/*.ducktor');
  context.subscriptions.push(watcher, watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.fsPath.endsWith('.ducktor')) refresh();
      else {
        termResults.delete(event.document.uri.toString());
        if (panelHighlight?.file === event.document.uri.fsPath) panelHighlight = undefined;
        clearTemporaryHighlight();
        updateDecorations();
        hintsChanged.fire();
        updatePanels(event.document.uri.fsPath);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => { updateDecorations(); applyBlockHighlight(); }),
    vscode.window.onDidChangeTextEditorSelection(() => { if (!openingHighlights) clearTemporaryHighlight(); }),
    vscode.window.onDidChangeActiveTextEditor(() => { if (!openingHighlights) clearTemporaryHighlight(); }),
    vscode.workspace.onDidCloseTextDocument(document => {
      termResults.delete(document.uri.toString());
      if (document.uri.fsPath.endsWith('.ducktor')) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('ducktor')) refresh();
      else if (event.affectsConfiguration('editor')) updatePanels();
    })
  );
  updateDecorations();
}

module.exports = { activate };
