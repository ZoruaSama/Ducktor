'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const YAML = require('yaml');
const { translate } = require('./localization');

const anchorTypes = new Set(['function', 'class', 'method', 'variable', 'constant', 'comment', 'text', 'hash']);

function parseRange(value) {
  if (value === '*') return { all: true };
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value));
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start
    ? { start: start - 1, end: end - 1 } : undefined;
}

function parseDucktor(source, language = 'en') {
  const t = (key, values) => translate(language, key, values);
  const document = YAML.parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
  const data = document.toJS({ maxAliasCount: 100 });
  if (!Array.isArray(data) && (!data || typeof data !== 'object' || (!Object.hasOwn(data, 'blocks') && !Object.hasOwn(data, 'terms')))) throw new Error(t('invalidTopLevel'));
  const blockItems = Array.isArray(data) ? data : data.blocks ?? [];
  const termItems = Array.isArray(data) ? [] : data.terms ?? [];
  if (!Array.isArray(blockItems) || !Array.isArray(termItems)) throw new Error(t('invalidLists'));
  const blocks = [];
  const terms = [];
  const errors = [];
  blockItems.forEach((item, index) => {
    const fail = message => errors.push(t('blockError', { index: index + 1, message }));
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(t('objectRequired'));
    const range = parseRange(item.range);
    if (!range || typeof item.content !== 'string') return fail(t('rangeContentRequired'));
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return fail(t('enabledBoolean'));
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string'))) return fail(t('tagsStrings'));
    let anchor = item.anchor;
    if (typeof anchor === 'string') anchor = { type: 'text', name: anchor };
    if (anchor !== undefined) {
      if (!anchor || !anchorTypes.has(anchor.type)) return fail(t('invalidAnchorType'));
      if (anchor.type === 'hash') {
        if (typeof anchor.value !== 'string' || !/^[a-f\d]{8,64}$/i.test(anchor.value)) return fail(t('invalidHash'));
      } else if (typeof anchor.name !== 'string' || !anchor.name.trim()) return fail(t('anchorNameRequired'));
    }
    if (item.level !== undefined && (typeof item.level !== 'string' || !/^L[1-5]$/.test(item.level))) return fail(t('invalidLevel'));
    if (item.lines !== undefined && (!Array.isArray(item.lines) || item.lines.some(entry =>
      !entry || !Number.isSafeInteger(entry.line) || entry.line < 1 || typeof entry.content !== 'string' ||
      (!range.all && (entry.line - 1 < range.start || entry.line - 1 > range.end))) ||
      new Set(item.lines.map(entry => entry.line)).size !== item.lines.length)) return fail(t('invalidLineExplanations'));
    if (item.enabled !== false) blocks.push({ range, anchor, content: item.content, lines: [...(item.lines || [])].sort((a, b) => a.line - b.line), tags: item.tags || [], level: item.level || 'L3', blockNumber: index + 1 });
  });
  termItems.forEach((item, index) => {
    const fail = message => errors.push(t('termError', { index: index + 1, message }));
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(t('objectRequired'));
    if (typeof item.symbol !== 'string' || !item.symbol.trim() || typeof item.content !== 'string') return fail(t('symbolContentRequired'));
    if (item.type !== undefined && !['class', 'variable', 'constant', 'enum', 'config'].includes(item.type)) return fail(t('invalidTermType'));
    if (item.scope !== undefined && !['global', 'module', 'local'].includes(item.scope)) return fail(t('invalidScope'));
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return fail(t('enabledBoolean'));
    if (item.level !== undefined && (typeof item.level !== 'string' || !/^L[1-5]$/.test(item.level))) return fail(t('invalidLevel'));
    for (const field of ['aliases', 'tags']) {
      if (item[field] !== undefined && (!Array.isArray(item[field]) || item[field].some(value => typeof value !== 'string' || !value.trim()))) return fail(t('nonEmptyStrings', { field }));
    }
    if (item.scope === 'local' && (!Number.isInteger(item.block) || item.block < 1 || item.block > blockItems.length)) return fail(t('localBlockRequired'));
    if (item.enabled !== false) terms.push({ ...item, scope: item.scope || 'global', aliases: item.aliases || [], tags: item.tags || [], level: item.level || 'L2', index });
  });
  return { blocks, terms, errors };
}

// 哈希以去除首尾空白的单行 UTF-8 文本为输入，忽略缩进和换行风格。
function lineHash(line) {
  return createHash('sha256').update(line.trim(), 'utf8').digest('hex');
}

function resolveBlock(block, lines, symbols = []) {
  const { range, anchor } = block;
  const candidates = [];
  if (anchor) {
    if (anchor.type === 'hash') {
      lines.forEach((line, index) => { if (lineHash(line).startsWith(anchor.value.toLowerCase())) candidates.push(index); });
    } else if (anchor.type === 'text' || anchor.type === 'comment') {
      lines.forEach((line, index) => {
        if (line.includes(anchor.name) && (anchor.type !== 'comment' || /^\s*(\/\/|\/\*|\*|#|--|<!--)/.test(line))) candidates.push(index);
      });
    } else {
      for (const symbol of symbols) {
        const qualified = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
        if ((symbol.name === anchor.name || qualified === anchor.name) && symbol.type === anchor.type) candidates.push(symbol.start);
      }
      // 没有语言服务器时只匹配声明，不将普通调用当成定义。
      if (!candidates.length && !anchor.name.includes('.')) {
        const name = anchor.name.split('.').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = {
          class: new RegExp(`\\b(?:class|struct|interface)\\s+${name}\\b`),
          function: new RegExp(`(?:\\b(?:function|def|fn|func)\\s+${name}\\b|\\b${name}\\s*\\([^;]*\\)\\s*(?:(?:const|noexcept|override|final)\\s*)*(?:\\{|=>)|\\b(?:const|let|var)\\s+${name}\\s*=.*=>)`),
          method: new RegExp(`\\b${name}\\s*\\([^;]*\\)\\s*(?:(?:const|noexcept|override|final)\\s*)*(?:\\{|:)`),
          variable: new RegExp(`(?:\\b(?:let|var|auto|int|float|double|char|string|bool)\\s+${name}\\b|^\\s*${name}\\s*=(?!=))`),
          constant: new RegExp(`\\b(?:const|constexpr|static\\s+final|#define)\\s+(?:\\w+\\s+)?${name}\\b`)
        };
        lines.forEach((line, index) => {
          const prefix = line.slice(0, line.search(new RegExp(`\\b${name}\\b`)));
          const callContext = /\b(?:if|while|for|switch|return|throw)\b/.test(prefix);
          if (!/^\s*(\/\/|\/\*|\*|#(?!define))/.test(line) && !callContext && patterns[anchor.type].test(line)) candidates.push(index);
        });
      }
    }
  }
  const original = range.all ? 0 : range.start;
  candidates.sort((a, b) => Math.abs(a - original) - Math.abs(b - original));
  const start = range.all ? 0 : candidates.length ? candidates[0] : range.start;
  if (start >= lines.length) return undefined;
  const end = range.all ? lines.length - 1 : Math.min(lines.length - 1, start + range.end - range.start);
  const lineExplanations = (block.lines || []).map(entry => ({ line: entry.line - 1 + start - original, content: entry.content }))
    .filter(entry => entry.line >= start && entry.line <= end);
  return { ...block, start, end, lineExplanations, drifted: !!anchor && !candidates.length };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function explanationFile(file, roots) {
  const root = roots.filter(root => isWithin(root, file)).sort((a, b) => b.length - a.length)[0];
  if (!root || file.endsWith('.ducktor') || isWithin(path.join(root, '.ducktor'), file)) return undefined;
  return path.join(root, '.ducktor', `${path.relative(root, file)}.ducktor`);
}

function codeFile(source, roots) {
  if (typeof source !== 'string' || !source.endsWith('.ducktor')) return undefined;
  const root = roots.filter(root => isWithin(root, source)).sort((a, b) => b.length - a.length)[0];
  if (!root || !isWithin(path.join(root, '.ducktor'), source)) return undefined;
  const file = path.join(root, path.relative(path.join(root, '.ducktor'), source).slice(0, -'.ducktor'.length));
  return explanationFile(file, roots) === source ? file : undefined;
}

function resolveFileTarget(target, sourceFile, roots) {
  if (typeof target !== 'string' || !target || /[\x00-\x1f]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return undefined;
  const match = /^(.*?)(?:#(\d+)(?:-(\d+))?)?$/.exec(target);
  if (!match || !match[1]) return undefined;
  const range = match[2] ? parseRange(`${match[2]}${match[3] ? `-${match[3]}` : ''}`) : undefined;
  if (match[2] && !range) return undefined;
  const file = path.resolve(path.dirname(sourceFile), match[1]);
  if (!roots.some(root => isWithin(root, file))) return undefined;
  return { file, start: range?.start, end: range?.end };
}

function findTermMatches(lines, terms) {
  const matches = [];
  lines.forEach((line, lineNumber) => {
    const active = terms.filter(term => !term.localRange || (lineNumber >= term.localRange.start && lineNumber <= term.localRange.end));
    const names = [...new Set(active.flatMap(term => [term.symbol, ...term.aliases]))].sort((a, b) => b.length - a.length);
    if (!names.length) return;
    const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_$])`, 'giu');
    for (const match of line.matchAll(pattern)) {
      const ranked = active.map(term => {
        const rank = term.symbol === match[0] ? 0 : term.aliases.includes(match[0]) ? 1 :
          [term.symbol, ...term.aliases].some(name => name.toLowerCase() === match[0].toLowerCase()) ? 2 : 3;
        return { term, rank };
      }).filter(item => item.rank < 3).sort((a, b) => a.rank - b.rank || ['local', 'module', 'global'].indexOf(a.term.scope) - ['local', 'module', 'global'].indexOf(b.term.scope));
      if (ranked.length) matches.push({ line: lineNumber, start: match.index, end: match.index + match[0].length, term: ranked[0].term });
    }
  });
  return matches;
}

module.exports = { parseRange, parseDucktor, lineHash, resolveBlock, isWithin, explanationFile, codeFile, resolveFileTarget, findTermMatches };
