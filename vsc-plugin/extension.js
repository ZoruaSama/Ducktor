'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { parseDucktor, resolveBlock, resolveFileTarget, isWithin, explanationFile, codeFile, findTermMatches } = require('./core');
const { COMMANDS, commandLink, renderMarkdown, renderPanelMarkdown, escapeHtml, renderSourceLines, hasDiagram } = require('./rendering');
const { randomBytes } = require('node:crypto');
const { translate } = require('./localization');
const { renderIndexPage } = require('./index-view');

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
  const indexState = { panel: undefined, revision: 0, targets: new Map() };
  function refreshIndex() {
    updateIndex().catch(error => output.appendLine(t('panelUpdateFailed', { error: error.message })));
  }
  const refresh = () => {
    generation++; cache.clear(); globalTerms = undefined; termResults.clear(); diagnostics.clear(); hintsChanged.fire();
    clearTemporaryHighlight();
    panelHighlight = undefined;
    applyBlockHighlight();
    updateDecorations();
    updatePanels();
    refreshIndex();
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

  async function diagramDestination(target, source) {
    const file = await safeFile(target, source);
    return file ? commandLink('ducktor.openFile', [{ target, source }]) : undefined;
  }

  async function termMarkdown(term, hover = false, diagramLinks) {
    return renderMarkdown(term.content, (target, shortcut) => resolveLink(target, shortcut, term.source, new Map()), { hover, diagramLinks, resolveDiagramLink: target => diagramDestination(target, term.source) });
  }

  async function blockMarkdown(document, blocks, hover = false, diagramLinks) {
    const symbolCache = new Map();
    const values = [];
    for (const block of blocks) {
      const value = await renderMarkdown(block.content, (target, shortcut) => resolveLink(target, shortcut, sourceUri(document).fsPath, symbolCache), { hover, diagramLinks, resolveDiagramLink: target => diagramDestination(target, sourceUri(document).fsPath) });
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
    const diagrams = standalone ? undefined : [];
    const markdown = target.termSource ? (term ? await termMarkdown(term, false, diagrams) : '') : await blockMarkdown(document, matched, false, diagrams);
    const links = new Map();
    const lines = new Map();
    const overview = markdown ? renderPanelMarkdown(markdown, links, { diagrams }) : `<p>${escapeHtml(t('noExplanation'))}</p>`;
    const aligned = standalone;
    let content = '';
    let overlayJson = '[]';
    let blockTipJson = '{}';
    if (aligned) {
      const sourceLines = renderSourceLines(document.getText(), document.languageId);
      const symbolCache = new Map();
      const entries = new Map();
      // 收集逐行预览范围内的术语，用于源码列 dotted underline + hover
      const allTermMatches = await termMatches(document);
      const termOverlays = [];
      for (let idx = 0; idx < allTermMatches.length; idx++) {
        const match = allTermMatches[idx];
        if (!matched.some(block => match.line >= block.start && match.line <= block.end)) continue;
        // 预渲染术语内容为 HTML（用于 webview hover tooltip）
        const termMd = await termMarkdown(match.term, false, []);
        const termLinks = new Map();
        const termHtml = renderPanelMarkdown(termMd, termLinks);
        // 把 termLinks 的 command 并入 links，这样 tooltip 里的链接也能点
        for (const [k, v] of termLinks) links.set(k, v);
        termOverlays.push({
          line: match.line,
          start: match.start,
          end: match.end,
          termId: String(idx),
          termSource: match.term.source,
          termIndex: match.term.index,
          symbol: match.term.symbol,
          tooltipHtml: termHtml
        });
      }
      // 收集所有块的起始行 → 预渲染 content HTML（用于 webview block hover）
      // 注意：blockTips 必须覆盖所有 blocks，而不是只有 matched（有 lineExplanations 的），
      // 因为用户可能只写了块级说明没有逐行解释。
      const blockTips = new Map();
      for (const block of blocks) {
        if (!block || typeof block.start !== 'number') continue;
        const blockMd = await blockMarkdown(document, [block], false, []);
        const blockLinks = new Map();
        const blockHtml = renderPanelMarkdown(blockMd, blockLinks);
        for (const [k, v] of blockLinks) links.set(k, v);
        blockTips.set(block.start, { index: block.index, start: block.start, end: block.end, tooltipHtml: blockHtml });
      }
      // 序列化前删除内部不传输的字段
      for (const [k, v] of blockTips) { delete v.index; delete v.start; delete v.end; }
      overlayJson = JSON.stringify(termOverlays).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      blockTipJson = JSON.stringify(Object.fromEntries(blockTips)).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      // 为 source-row 生成 data-block 属性（只有 block 起始行有）
      const blockAttrs = [];
      for (let line = 0; line < document.lineCount; line++) {
        const tip = blockTips.get(line);
        blockAttrs.push(tip ? `data-block-index="${tip.index}"` : '');
      }
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
      content = `<div id="line-grid" aria-label="${escapeHtml(t('lineExplanations'))}"><div class="column-head"><span>${escapeHtml(t('sourceCode'))}</span><span>${escapeHtml(t('lineExplanations'))}</span></div>${Array.from({ length: document.lineCount }, (_, line) => `<div class="source-row${matched.some(block => line >= block.start && line <= block.end) ? ' selected' : ''}" data-source-line="${line}" ${blockAttrs[line]}><div class="source-cell"><button class="line-number" data-source="${line}" title="${escapeHtml(t('openSource'))}">${line + 1}</button><code class="source-code">${sourceLines[line]}</code></div><div class="row-content">${(entries.get(line) || []).join('')}</div></div>`).join('')}</div>`;
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
    const diagramScript = !standalone && diagrams.length ? `<script nonce="${nonce}" src="${currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'diagrams.js'))}"></script>` : '';
    currentPanel.webview.html = `<!DOCTYPE html><html lang="${language}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; ${diagramScript ? "style-src-attr 'unsafe-inline';" : ''} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;overflow:hidden;font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);--preview-font-size:${fontSize}px;--row-height:${lineHeight}px}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;min-height:50px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
header span{flex:1;min-width:100px}nav{display:flex;gap:4px}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 9px;cursor:pointer;font:inherit}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}nav button{background:transparent;color:var(--vscode-editor-foreground)}nav button[aria-selected="true"]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}a{color:var(--vscode-textLink-foreground)}
body{display:flex;flex-direction:column;height:100vh}main{flex:1;min-height:0;overflow:auto;overflow-anchor:none}#overview{padding:24px 32px;max-width:1100px;margin:0 auto;line-height:1.6;overflow-wrap:anywhere}
.ducktor-color-red{color:#f14c4c}.ducktor-color-blue{color:#3794ff}.ducktor-color-green{color:#73c991}.ducktor-color-orange{color:#e99547}.ducktor-color-yellow{color:#d7ba7d}.ducktor-color-gray{color:#999}.vscode-light .ducktor-color-red{color:#c62828}.vscode-light .ducktor-color-blue{color:#005fb8}.vscode-light .ducktor-color-green{color:#287d38}.vscode-light .ducktor-color-orange{color:#a65300}.vscode-light .ducktor-color-yellow{color:#806600}.vscode-light .ducktor-color-gray{color:#666}.ducktor-underline{text-decoration:underline}
.ducktor-diagram{overflow:auto;margin:16px 0}.ducktor-diagram svg{display:block;max-width:100%;height:auto;margin:auto}.ducktor-diagram [data-link]{cursor:pointer}.ducktor-diagram [data-link]:focus{outline:2px solid var(--vscode-focusBorder)}.diagram-error{color:var(--vscode-errorForeground)}
pre{background:var(--vscode-textCodeBlock-background);padding:12px;overflow:auto}code{font-family:var(--vscode-editor-font-family)}blockquote{border-left:3px solid var(--vscode-textBlockQuote-border);margin-left:0;padding-left:12px}h1,h2,h3,h4{line-height:1.3}[hidden]{display:none!important}
#line-grid{font-family:var(--vscode-editor-font-family);font-weight:var(--vscode-editor-font-weight);font-size:var(--preview-font-size);line-height:var(--row-height);padding-bottom:24px}
.source-row,.column-head{display:grid;grid-template-columns:minmax(0,var(--source-ratio,50%)) minmax(0,1fr)}.source-row{min-height:var(--row-height)}
#lines{position:relative}#splitter{position:absolute;top:0;bottom:0;left:var(--source-ratio,50%);width:9px;transform:translateX(-50%);z-index:2;cursor:col-resize;touch-action:none;background:transparent}#splitter:hover,#splitter:focus-visible{background:var(--vscode-focusBorder);outline:0;opacity:.6}body.resizing{cursor:col-resize;user-select:none}
.column-head{position:sticky;top:0;z-index:1;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);font-family:var(--vscode-font-family);font-size:12px;font-weight:normal}.column-head span{padding:8px 12px}.column-head span+span{border-left:1px solid var(--vscode-panel-border)}
.source-cell{display:flex;align-items:flex-start;min-width:0;padding:0 12px 0 0}.line-number{flex:0 0 54px;text-align:right;padding:0 12px 0 0;background:transparent;color:var(--vscode-editorLineNumber-foreground);line-height:var(--row-height)}.source-code{display:block;background:transparent;padding:0;border:0;border-radius:0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:${config.get('tabSize', 4)};font:inherit}
.source-code{--syntax-keyword:#569cd6;--syntax-string:#ce9178;--syntax-number:#b5cea8;--syntax-comment:#6a9955;--syntax-title:#dcdcaa;--syntax-type:#4ec9b0;--syntax-variable:#9cdcfe}.vscode-light .source-code{--syntax-keyword:#0000ff;--syntax-string:#a31515;--syntax-number:#098658;--syntax-comment:#008000;--syntax-title:#795e26;--syntax-type:#267f99;--syntax-variable:#001080}.source-code .hljs-keyword,.source-code .hljs-selector-tag,.source-code .hljs-literal{color:var(--syntax-keyword)}.source-code .hljs-string,.source-code .hljs-regexp{color:var(--syntax-string)}.source-code .hljs-number{color:var(--syntax-number)}.source-code .hljs-comment,.source-code .hljs-quote{color:var(--syntax-comment)}.source-code .hljs-title{color:var(--syntax-title)}.source-code .hljs-type,.source-code .hljs-built_in,.source-code .hljs-title.class_{color:var(--syntax-type)}.source-code .hljs-variable,.source-code .hljs-attr,.source-code .hljs-attribute,.source-code .hljs-params,.source-code .hljs-property{color:var(--syntax-variable)}.source-code .hljs-tag,.source-code .hljs-name,.source-code .hljs-meta{color:var(--syntax-keyword)}
.row-content{min-width:0;border-left:1px solid var(--vscode-panel-border);padding:0 12px;overflow-wrap:anywhere}.line-explanation p{margin:0}.line-explanation pre{margin:0;padding:8px}.line-explanation ul,.line-explanation ol{margin:0;padding-left:24px}.line-explanation h1,.line-explanation h2,.line-explanation h3,.line-explanation h4{font-size:1em;margin:0;line-height:inherit}.line-explanation blockquote{margin:0}.line-explanation+.line-explanation{margin-top:8px}.jump-line{float:right;margin-left:8px;background:transparent;color:var(--vscode-textLink-foreground);font-size:11px;line-height:var(--row-height);padding:0}
/* line search & hover sync */
#line-search{flex:0 0 auto;display:flex;align-items:center;gap:4px}#line-search input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;padding:4px 6px;font:inherit;width:200px}#line-search input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}#line-search .clear-search{background:transparent;color:var(--vscode-descriptionForeground);border:0;padding:2px 4px;cursor:pointer;font-size:12px;line-height:1}#line-search .clear-search:hover{color:var(--vscode-foreground)}#line-search .clear-search[hidden]{display:none!important}
#line-search .search-controls{display:flex;align-items:center;gap:2px}#line-search .search-controls button{background:transparent;border:1px solid transparent;color:var(--vscode-descriptionForeground);border-radius:2px;padding:2px 4px;cursor:pointer;font-size:11px;line-height:1}#line-search .search-controls button:hover{color:var(--vscode-foreground);background:rgba(128,128,128,.12)}#line-search .search-controls button.active{color:var(--vscode-foreground);background:var(--vscode-inputOption-activeBackground,transparent);border-color:var(--vscode-inputOption-activeBorder,transparent)}#line-search .match-count{font-size:11px;color:var(--vscode-descriptionForeground);min-width:32px;text-align:center}#line-search .nav-btn{font-size:14px;padding:1px 4px}#line-search .nav-btn:disabled{opacity:.4;cursor:default}
.source-row:hover{background:rgba(128,128,128,.12)}.vscode-dark .source-row:hover{background:rgba(200,200,200,.08)}
.source-row.current-match{background:rgba(128,128,128,.18)}.vscode-dark .source-row.current-match{background:rgba(200,200,200,.14)}
.source-row.dim-row{opacity:.35}
mark.search-hit{background:rgba(255,204,0,.35);color:inherit;border-radius:2px;padding:0 1px}
mark.search-current{background:rgba(255,140,0,.55);color:inherit;border-radius:2px;padding:0 1px}
/* term overlays */
.ducktor-term{text-decoration:underline dotted var(--vscode-textLink-foreground);cursor:pointer;border-radius:2px;padding:0 1px}.ducktor-term:hover{background:rgba(128,128,128,.18)}.vscode-dark .ducktor-term:hover{background:rgba(200,200,200,.12)}
/* term tooltip */
#ducktor-term-tooltip{position:fixed;z-index:9999;max-width:420px;padding:8px 12px;border-radius:4px;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground);border:1px solid var(--vscode-editorHoverWidget-border);box-shadow:0 2px 8px rgba(0,0,0,.3);font-family:var(--vscode-font-family);font-size:13px;line-height:1.5;pointer-events:none;white-space:normal;overflow-wrap:anywhere;display:none}
#ducktor-term-tooltip.show{display:block}
#ducktor-term-tooltip strong{font-weight:600}
/* term popover (click to open) */
#ducktor-term-popover{position:fixed;z-index:9998;max-width:560px;max-height:70vh;padding:12px 16px;border-radius:6px;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground);border:1px solid var(--vscode-editorHoverWidget-border);box-shadow:0 4px 16px rgba(0,0,0,.3);font-family:var(--vscode-font-family);font-size:13px;line-height:1.6;overflow:auto;display:none}
#ducktor-term-popover.show{display:block}
#ducktor-term-popover strong{font-weight:600}
#ducktor-term-popover .popover-close{position:absolute;top:4px;right:6px;background:none;border:0;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;border-radius:3px}
#ducktor-term-popover .popover-close:hover{background:rgba(128,128,128,.25)}
</style></head><body><header><span>${escapeHtml(path.basename(document.uri.fsPath))}${term ? ` · ${escapeHtml(term.symbol)}` : selected ? ` · ${escapeHtml(t('line', { line: selected.start + 1 }))}` : ''}</span>${aligned ? `<nav role="tablist" aria-label="${escapeHtml(t('panelTitle'))}"><button role="tab" data-mode="overview" aria-controls="overview" aria-selected="${initialMode === 'overview'}">${escapeHtml(t('blockOverview'))}</button><button role="tab" data-mode="lines" aria-controls="lines" aria-selected="${initialMode === 'lines'}">${escapeHtml(t('lineExplanations'))}</button></nav><div id="line-search" role="search"><input type="search" placeholder="${escapeHtml(t('lineSearch'))}" aria-label="${escapeHtml(t('lineSearch'))}" /><button class="clear-search" type="button" aria-label="${escapeHtml(t('lineSearchClear'))}" hidden>✕</button><div class="search-controls" role="group" aria-label="Search options"><button class="opt-case" type="button" title="Match case (Aa)" aria-label="Match case">Aa</button><button class="opt-word" type="button" title="Whole word (ab)" aria-label="Whole word">ab</button><button class="opt-regex" type="button" title="Use regex (.*)" aria-label="Use regex">.*</button></div><div class="match-count" aria-live="polite" aria-label="Match count">0/0</div><div class="search-controls"><button class="nav-btn prev" type="button" title="Previous match (Shift+F3)" aria-label="Previous match">▲</button><button class="nav-btn next" type="button" title="Next match (F3)" aria-label="Next match">▼</button></div></div>` : ''}<button data-action="clear">${escapeHtml(t('clear'))}</button><button data-action="clearAll">${escapeHtml(t('clearAll'))}</button></header><main><section id="overview"${initialMode !== 'overview' ? ' hidden' : ''}>${overview}</section>${aligned ? `<section id="lines"${initialMode !== 'lines' ? ' hidden' : ''}>${content}<div id="splitter" role="separator" aria-label="${language === 'zh-CN' ? '调整左右列宽' : 'Resize columns'}" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50" tabindex="0"></div></section>` : ''}</main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const revision=${revision};const main=document.querySelector('main');const identity=${JSON.stringify(`${target.file}:${standalone ? 'lines' : `${target.termSource || ''}:${target.termIndex ?? target.index}`}`).replace(/</g, '\\u003c')};const initialMode=${JSON.stringify(initialMode)};const saved=vscode.getState();let mode=initialMode;const positions={overview:0,lines:0};
const TERM_OVERLAYS = ${overlayJson};
const BLOCK_TIPS = ${blockTipJson};
const splitter=document.getElementById('splitter');let ratio=saved&&Number.isFinite(saved.ratio)?Math.max(20,Math.min(80,saved.ratio)):50;
function save(){positions[mode]=main.scrollTop;vscode.setState({identity,mode,positions,ratio});}
function resize(value){ratio=Math.max(20,Math.min(80,value));document.getElementById('lines').style.setProperty('--source-ratio',ratio+'%');splitter.setAttribute('aria-valuenow',String(Math.round(ratio)));save();}
if(splitter){resize(ratio);let pointer;splitter.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();pointer=event.pointerId;splitter.setPointerCapture(pointer);document.body.classList.add('resizing');});splitter.addEventListener('pointermove',event=>{if(event.pointerId!==pointer)return;const bounds=document.getElementById('line-grid').getBoundingClientRect();if(bounds.width)resize((event.clientX-bounds.left)/bounds.width*100);});const finish=()=>{pointer=undefined;document.body.classList.remove('resizing');save();};splitter.addEventListener('pointerup',finish);splitter.addEventListener('pointercancel',finish);splitter.addEventListener('lostpointercapture',finish);splitter.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'||event.key==='Home'){event.preventDefault();resize(event.key==='Home'?50:ratio+(event.key==='ArrowLeft'?-2:2));}});}
function switchMode(next,remember=true){if(!document.getElementById(next))return;if(remember)positions[mode]=main.scrollTop;mode=next;document.getElementById('overview').hidden=mode!=='overview';const lines=document.getElementById('lines');if(lines)lines.hidden=mode!=='lines';document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.mode===mode)));main.scrollTop=positions[mode];save();}
if(saved&&saved.identity===identity){Object.assign(positions,saved.positions);switchMode(saved.mode,false);}else{switchMode(initialMode);if(initialMode==='lines'){const row=document.querySelector('[data-source-line="${matched[0]?.start || 0}"]');if(row)main.scrollTop=Math.max(0,row.offsetTop-48);save();}}
main.addEventListener('scroll',save);
document.addEventListener('click',event=>{const element=event.target.closest('[data-action],[data-link],[data-line],[data-source],[data-mode]');if(!element)return;event.preventDefault();if(element.dataset.mode){switchMode(element.dataset.mode);return;}vscode.postMessage({revision,action:element.dataset.action,link:element.dataset.link,line:element.dataset.line,sourceLine:element.dataset.source===undefined?undefined:Number(element.dataset.source)});});
/* line search v2: mark highlight + dim + navigation + options */
const searchInput=document.querySelector('#line-search input');
const clearBtn=document.querySelector('#line-search .clear-search');
const matchCountEl=document.querySelector('#line-search .match-count');
const prevBtn=document.querySelector('#line-search .nav-btn.prev');
const nextBtn=document.querySelector('#line-search .nav-btn.next');
const optCaseBtn=document.querySelector('#line-search .opt-case');
const optWordBtn=document.querySelector('#line-search .opt-word');
const optRegexBtn=document.querySelector('#line-search .opt-regex');
const rows=Array.from(document.querySelectorAll('.source-row'));
let searchOpts={case:false,word:false,regex:false};
let matchRows=[];let currentMatchIdx=-1;

function clearHighlights(root){
  // 移除所有 <mark> 节点，保持内部文本
  root.querySelectorAll('mark.search-hit,mark.search-current').forEach(m=>{
    const p=m.parentNode;while(m.firstChild)p.insertBefore(m.firstChild,m);p.removeChild(m);
  });
}
function compileNeedle(needle,opts){
  if(!needle)return null;
  try{
    const re = new RegExp('[.*+?^$()|[\\]\\\\]', 'g');
    const esc=opts.regex?needle:needle.replace(re,'\\$&');
    const pat=opts.word?'\\b'+esc+'\\b':esc;
    return new RegExp(pat,opts.case?'g':'gi');
  }catch(e){return null;}
}
function markRangesInNode(root,ranges,cls){
  // ranges: [{start,end}] sorted by start desc (大到小切避免 offset 问题)
  if(!ranges.length)return;
  const sorted=[...ranges].sort((a,b)=>b.start-a.start);
  for(const range of sorted){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const infos=[];let off=0,node;
    while((node=walker.nextNode())){infos.push({tn:node,s:off,e:off+node.textContent.length});off+=node.textContent.length;}
    for(let i=infos.length-1;i>=0;i--){
      const info=infos[i];
      const s=Math.max(range.start,info.s),e=Math.min(range.end,info.e);
      if(s>=e)continue;
      let ls=s-info.s,le=e-info.s;
      let tn=info.tn;
      if(le<tn.textContent.length)tn=tn.splitText(le);
      if(ls>0)tn=info.tn.splitText(ls);
      const m=document.createElement('mark');m.className=cls;m.dataset.matchIdx=range.matchIdx;
      tn.parentNode.insertBefore(m,tn);m.appendChild(tn);
    }
  }
}
function collectRanges(el,regex,matchIdx){
  // 返回所有匹配的 {start,end,matchIdx}
  if(!el)return [];
  const text=el.textContent;
  regex.lastIndex=0;const ranges=[];let m;
  while((m=regex.exec(text))!==null){
    ranges.push({start:m.index,end:m.index+m[0].length,matchIdx});
    if(!m[0].length){regex.lastIndex++;if(regex.lastIndex>text.length)break;}
  }
  return ranges;
}
function findMatches(){
  // 清除旧高亮
  for(const row of rows){clearHighlights(row);row.classList.remove('dim-row','current-match');row.querySelectorAll('mark.search-hit').forEach(m=>m.className='');}
  const needle=searchInput.value;
  if(!needle.trim()){matchRows=[];currentMatchIdx=-1;matchCountEl.textContent='0/0';prevBtn.disabled=nextBtn.disabled=true;return;}
  const regex=compileNeedle(needle.trim(),searchOpts);
  if(!regex){matchCountEl.textContent='0/0';prevBtn.disabled=nextBtn.disabled=true;return;}
  matchRows=[];
  rows.forEach((row,idx)=>{
    const sourceCell=row.querySelector('.source-code');
    const explCell=row.querySelector('.row-content');
    let hit=false;let hitIdx=matchRows.length;
    // 源码列
    const srcRanges=collectRanges(sourceCell,regex,hitIdx);
    if(srcRanges.length){markRangesInNode(sourceCell,srcRanges,'search-hit');hit=true;}
    // 解释列
    const expRanges=collectRanges(explCell,regex,hitIdx);
    if(expRanges.length){markRangesInNode(explCell,expRanges,'search-hit');hit=true;}
    if(hit){matchRows.push({row,idx});row.classList.remove('dim-row');}
    else row.classList.add('dim-row');
  });
  matchCountEl.textContent=matchRows.length?('0/'+matchRows.length):'0/0';
  prevBtn.disabled=nextBtn.disabled=matchRows.length===0;
  currentMatchIdx=matchRows.length?0:-1;
  if(currentMatchIdx>=0)gotoMatch(0);
}
function gotoMatch(delta){
  if(!matchRows.length)return;
  currentMatchIdx=((currentMatchIdx+delta)%matchRows.length+matchRows.length)%matchRows.length;
  matchRows.forEach((m,i)=>{
    const marks=m.row.querySelectorAll('mark.search-current');
    marks.forEach(x=>{x.classList.remove('search-current');x.classList.add('search-hit');});
    if(i===currentMatchIdx){
      m.row.classList.add('current-match');
      m.row.querySelectorAll('mark.search-hit').forEach(x=>x.classList.add('search-current'));
      m.row.scrollIntoView({block:'center'});
    }
  });
  matchCountEl.textContent=(currentMatchIdx+1)+'/'+matchRows.length;
}

/* 事件绑定 */
if(saved?.identity===identity){
  if(typeof saved.lineSearch==='string')searchInput.value=saved.lineSearch;
  if(saved.searchOpts){searchOpts=saved.searchOpts;}
}
function updateOptBtns(){
  optCaseBtn.classList.toggle('active',searchOpts.case);
  optWordBtn.classList.toggle('active',searchOpts.word);
  optRegexBtn.classList.toggle('active',searchOpts.regex);
}
updateOptBtns();
optCaseBtn.addEventListener('click',()=>{searchOpts.case=!searchOpts.case;updateOptBtns();findMatches();persist();});
optWordBtn.addEventListener('click',()=>{searchOpts.word=!searchOpts.word;updateOptBtns();findMatches();persist();});
optRegexBtn.addEventListener('click',()=>{searchOpts.regex=!searchOpts.regex;updateOptBtns();findMatches();persist();});
prevBtn.addEventListener('click',()=>gotoMatch(-1));
nextBtn.addEventListener('click',()=>gotoMatch(1));
function persist(){saved.lineSearch=searchInput.value;saved.searchOpts=searchOpts;vscode.setState(saved);}
searchInput.addEventListener('input',()=>{persist();findMatches();});
searchInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();gotoMatch(1);}
  else if(e.key==='F3'){e.preventDefault();gotoMatch(e.shiftKey?-1:1);}
});
// Ctrl/Cmd+F 聚焦
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();searchInput.focus();searchInput.select();}
  else if(e.key==='F3'){e.preventDefault();gotoMatch(e.shiftKey?-1:1);}
});
if(clearBtn){clearBtn.addEventListener('click',()=>{searchInput.value='';persist();findMatches();searchInput.focus();});}
if(searchInput.value)findMatches();
/* term overlay marking via TreeWalker + splitText */
function markTermsInNode(root, ranges){
  if(!ranges.length)return;
  const sorted=[...ranges].sort((a,b)=>b.start-a.start);
  for(const range of sorted){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const infos=[];let offset=0,node;
    while((node=walker.nextNode())){infos.push({tn:node,start:offset,end:offset+node.textContent.length});offset+=node.textContent.length;}
    for(let i=infos.length-1;i>=0;i--){
      const info=infos[i];
      const overlapStart=Math.max(range.start,info.start);
      const overlapEnd=Math.min(range.end,info.end);
      if(overlapStart>=overlapEnd)continue;
      let localStart=overlapStart-info.start,localEnd=overlapEnd-info.start;
      let targetNode=info.tn;
      if(localEnd<targetNode.textContent.length)targetNode=targetNode.splitText(localEnd);
      if(localStart>0)targetNode=info.tn.splitText(localStart);
      const span=document.createElement('span');
      span.className='ducktor-term';
      span.dataset.termId=range.termId;
      span.dataset.termSource=range.termSource;
      span.dataset.termIndex=range.termIndex;
      targetNode.parentNode.insertBefore(span,targetNode);
      span.appendChild(targetNode);
    }
  }
}
if(TERM_OVERLAYS.length){
  for(const row of document.querySelectorAll('.source-row')){
    const line=Number(row.dataset.sourceLine);
    const lineOverlays=TERM_OVERLAYS.filter(o=>o.line===line);
    if(lineOverlays.length)markTermsInNode(row.querySelector('.source-code'),lineOverlays);
  }
}
/* term popover (click to open, replace side panel navigation) */
const popover=document.getElementById('ducktor-term-popover');
let popoverHideTimer=null;
let activePopoverTermId=null;
function positionPopover(el){
  const rect=el.getBoundingClientRect();
  let left=rect.left;
  let top=rect.bottom+8;
  const pw=popover.offsetWidth,ph=popover.offsetHeight;
  if(left+pw>window.innerWidth-8)left=window.innerWidth-pw-8;
  if(left<8)left=8;
  if(top+ph>window.innerHeight-8)top=rect.top-ph-8;
  if(top<8)top=8;
  popover.style.left=left+'px';popover.style.top=top+'px';
}
function showPopover(html,el,termId){
  clearTimeout(popoverHideTimer);
  clearTimeout(tooltipHideTimer);
  hideTooltip();
  activePopoverTermId=termId;
  popover.innerHTML='<button class="popover-close" aria-label="Close">✕</button>'+html;
  popover.classList.add('show');
  // popover 内链接点击 → postMessage
  popover.querySelectorAll('[data-link]').forEach(a=>{
    a.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();vscode.postMessage({revision,link:a.dataset.link});});
  });
  popover.querySelector('.popover-close').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();hidePopover();});
  requestAnimationFrame(()=>positionPopover(el));
}
function hidePopover(){popover.classList.remove('show');activePopoverTermId=null;}
document.addEventListener('click',event=>{
  // 点击 popover 内部 → 不关闭
  if(popover.classList.contains('show')&&popover.contains(event.target))return;
  const termSpan=event.target.closest('.ducktor-term');
  if(termSpan){
    event.preventDefault();event.stopPropagation();
    const termId=termSpan.dataset.termId;
    if(activePopoverTermId===termId){hidePopover();return;} // 再点同一术语 → 关闭
    const t=TERM_OVERLAYS.find(o=>o.termId===termId);
    if(t&&t.tooltipHtml){showPopover(t.tooltipHtml,termSpan,termId);}
    return;
  }
  // 点击外部 → 关闭 popover
  if(popover.classList.contains('show')){hidePopover();}
});
// ESC 关闭 popover
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&popover.classList.contains('show')){e.preventDefault();hidePopover();}});
/* tooltip show/hide for term and block hover */
const tooltip=document.getElementById('ducktor-term-tooltip');
let tooltipHideTimer=null;
function positionTooltip(el){
  const rect=el.getBoundingClientRect();
  let left=rect.left;
  let top=rect.bottom+6;
  const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  if(left+tw>window.innerWidth-8)left=window.innerWidth-tw-8;
  if(left<8)left=8;
  if(top+th>window.innerHeight-8)top=rect.top-th-6;
  if(top<8)top=8;
  tooltip.style.left=left+'px';tooltip.style.top=top+'px';
}
function showTooltip(html,el){
  clearTimeout(tooltipHideTimer);
  tooltip.innerHTML=html;
  tooltip.classList.add('show');
  // 让 tooltip 里的链接也能点
  tooltip.querySelectorAll('[data-link]').forEach(a=>{
    a.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();vscode.postMessage({revision,link:a.dataset.link});});
  });
  requestAnimationFrame(()=>positionTooltip(el));
}
function hideTooltip(){tooltipHideTimer=setTimeout(()=>tooltip.classList.remove('show'),150);}
// term hover
document.addEventListener('mouseover',e=>{
  const term=e.target.closest('.ducktor-term');
  if(!term)return;
  const t=TERM_OVERLAYS.find(o=>o.termId===term.dataset.termId);
  if(t&&t.tooltipHtml)showTooltip(t.tooltipHtml,term);
});
document.addEventListener('mouseout',e=>{
  const term=e.target.closest('.ducktor-term');
  if(term&&!term.contains(e.relatedTarget))hideTooltip();
});
// block hover（块范围内所有行都触发）
document.addEventListener('mouseover',e=>{
  const row=e.target.closest('.source-row');
  if(!row||row.querySelector('.ducktor-term:hover'))return; // term hover 优先
  const line=Number(row.dataset.sourceLine);
  // 找到 BLOCK_TIPS 里 start <= line 的最大的那个（即覆盖当前行的块起始行）
  let bestStart=-1;let bestTip=null;
  for(const [start,tip] of Object.entries(BLOCK_TIPS)){
    const s=Number(start);
    if(s<=line&&s>bestStart){bestStart=s;bestTip=tip;}
  }
  if(bestTip&&bestTip.tooltipHtml)showTooltip(bestTip.tooltipHtml,row);
});
document.addEventListener('mouseout',e=>{
  const row=e.target.closest('.source-row');
  if(row&&!row.contains(e.relatedTarget)&&!row.querySelector('.ducktor-term:hover'))hideTooltip();
});
</script>${diagramScript}<div id="ducktor-term-popover" role="dialog" aria-live="polite"></div><div id="ducktor-term-tooltip" role="tooltip" aria-live="polite"></div></body></html>`;
  }

  async function openPanel(state, standalone, target) {
    state.target = target;
    state.revision++;
    const viewColumn = standalone ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    if (!state.panel) {
      const panel = vscode.window.createWebviewPanel(standalone ? 'ducktor.lineExplanation' : 'ducktor.explanation', standalone ? `Ducktor: ${path.basename(target.file)}` : t('panelTitle'), { viewColumn, preserveFocus: !standalone }, { enableScripts: true, localResourceRoots: standalone ? [] : [vscode.Uri.joinPath(context.extensionUri, 'media')] });
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
            else if (message.action === 'showTerm' && typeof message.termSource === 'string' && Number.isInteger(message.termIndex)) {
              // 打开术语所在编辑器，并在右侧面板显示术语解释
              try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
              } catch (_) {}
              sideState.request++;
              await openPanel(sideState, false, { file: target.file, termSource: message.termSource, termIndex: message.termIndex });
            }
            else if (typeof message.link === 'string' && state.links.has(message.link)) {
              const uri = vscode.Uri.parse(state.links.get(message.link));
              if (COMMANDS.includes(uri.path)) await vscode.commands.executeCommand(uri.path, ...JSON.parse(decodeURIComponent(uri.query)));
            }
          } catch (error) { output.appendLine(t('panelActionFailed', { error: error.message })); }
        }));
    } else state.panel.reveal(viewColumn, !standalone);
    await updatePanel(state, standalone);
  }

  function indexPage(panel) {
    const language = vscode.workspace.getConfiguration('ducktor').get('language', 'en');
    const labels = Object.fromEntries(Object.entries({ title: 'indexTitle', search: 'indexSearch', lines: 'lineExplanations', diagrams: 'indexDiagrams', all: 'indexAll', yes: 'indexYes', no: 'indexNo', blocks: 'indexBlocks', terms: 'indexTerms', refresh: 'indexRefresh', empty: 'indexEmpty', loading: 'indexLoading', files: 'indexFiles', line: 'line' }).map(([key, value]) => [key, t(value)]));
    panel.title = t('indexTitle');
    indexState.language = language;
    panel.webview.html = renderIndexPage(randomBytes(16).toString('hex'), language, labels);
  }

  async function updateIndex() {
    const panel = indexState.panel;
    if (!panel) return;
    if (indexState.language !== vscode.workspace.getConfiguration('ducktor').get('language', 'en')) {
      indexPage(panel);
      return;
    }
    const revision = ++indexState.revision;
    const currentGeneration = generation;
    const entries = [];
    const targets = new Map();
    const found = await vscode.workspace.findFiles('**/.ducktor/**/*.ducktor', null);
    const title = content => content.split(/\r?\n/).find(line => line.trim())?.trim().replace(/^#{1,6}\s+/, '').slice(0, 100) || t('indexBlocks');
    for (const uri of found.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      if (indexState.panel !== panel || revision !== indexState.revision || currentGeneration !== generation) return;
      if (uri.scheme !== 'file' || !await safeFile(path.basename(uri.fsPath), uri.fsPath, true)) continue;
      const file = codeFile(uri.fsPath, roots());
      if (!file) continue;
      const target = path.basename(file);
      if (!await safeFile(target, uri.fsPath)) continue;
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const version = document.version;
        const parsed = await loadUri(uri);
        const blocks = await resolvedBlocks(document);
        const sourceLines = document.getText().split(/\r?\n/);
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) continue;
        const navigation = (start, end = start) => {
          const id = String(targets.size);
          targets.set(id, { source: uri.fsPath, target: start === undefined ? target : `${target}#${start + 1}-${end + 1}` });
          return id;
        };
        const blockEntries = blocks.map(block => ({ id: navigation(block.start, block.end), title: title(block.content), start: block.start + 1, end: block.end + 1, hasDiagram: hasDiagram(block.content) }));
        const lineEntries = blocks.flatMap(block => (block.lineExplanations || []).map(item => ({ id: navigation(item.line), line: item.line + 1, title: title(item.content) })));
        const termEntries = parsed.terms.map(term => {
          const block = term.scope === 'local' ? blocks.find(block => block.blockNumber === term.block) : undefined;
          const matches = term.scope === 'local' && !block ? [] : findTermMatches(sourceLines, [{ ...term, localRange: block ? { start: block.start, end: block.end } : undefined }]);
          const line = matches[0]?.line ?? block?.start ?? 0;
          return { id: navigation(line), symbol: term.symbol, line: line + 1, hasDiagram: hasDiagram(term.content) };
        });
        if (version !== document.version) { refreshIndex(); return; }
        entries.push({ id: navigation(), name: target, root: folder.uri.fsPath, rootName: folder.name, relativePath: path.relative(folder.uri.fsPath, file).split(path.sep).join('/'), hasLines: lineEntries.length > 0, hasDiagrams: [...parsed.blocks, ...parsed.terms].some(item => hasDiagram(item.content)) || parsed.blocks.some(block => block.lines.some(item => hasDiagram(item.content))), blocks: blockEntries, lines: lineEntries, terms: termEntries });
      } catch (error) { output.appendLine(t('readFileFailed', { file, error: error.message })); }
    }
    if (indexState.panel !== panel || revision !== indexState.revision || currentGeneration !== generation) return;
    indexState.targets = targets;
    await panel.webview.postMessage({ type: 'index', revision, entries });
  }

  function showIndex() {
    if (indexState.panel) {
      indexState.panel.reveal(vscode.ViewColumn.Active);
      refreshIndex();
      return;
    }
    const panel = vscode.window.createWebviewPanel('ducktor.index', t('indexTitle'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    indexState.panel = panel;
    context.subscriptions.push(panel, panel.onDidDispose(() => {
      indexState.panel = undefined;
      indexState.revision++;
      indexState.targets.clear();
    }), panel.webview.onDidReceiveMessage(async message => {
      if (!message || indexState.panel !== panel) return;
      if (message.action === 'refresh' || message.action === 'ready') refreshIndex();
      else if (message.action === 'open' && message.revision === indexState.revision && typeof message.id === 'string' && indexState.targets.has(message.id)) {
        await openFile(indexState.targets.get(message.id));
      }
    }));
    indexPage(panel);
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
          const entry = `[${t('viewTermExplanation')}](${commandLink('ducktor.showExplanation', [args])})${hasDiagram(match.term.content) ? ` · [🧩](${commandLink('ducktor.showExplanation', [args])} "${t('viewDiagram')}")` : ''}`;
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
    vscode.commands.registerCommand('ducktor.showIndex', showIndex),
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
            const diagramMarker = matched.some(block => hasDiagram(block.content)) ? ` · [🧩](${commandLink('ducktor.showExplanation', [args])} "${t('viewDiagram')}")` : '';
            const entry = `[${t('highlightBlock')}](${commandLink('ducktor.highlightBlock', [args])}) · [${t('openPanel')}](${commandLink('ducktor.showExplanation', [args])}) · [${t('clear')}](${commandLink('ducktor.clear', [{ source: sourceUri(document).fsPath }])}) · [${t('clearAll')}](${commandLink('ducktor.clearAll', [])})${diagramMarker}`;
            const value = mode === 'panel' ? `[${t('viewExplanation')}](${commandLink('ducktor.showExplanation', [args])})${diagramMarker}\n\n${t('inlayClickHint')}` :
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
        refreshIndex();
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
    vscode.workspace.onDidCreateFiles(refreshIndex),
    vscode.workspace.onDidDeleteFiles(refreshIndex),
    vscode.workspace.onDidRenameFiles(refreshIndex),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('ducktor')) refresh();
      else if (event.affectsConfiguration('editor')) updatePanels();
    })
  );
  updateDecorations();
}

module.exports = { activate };
