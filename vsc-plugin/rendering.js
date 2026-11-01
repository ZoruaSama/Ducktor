'use strict';

const { marked } = require('marked');
const hljs = require('highlight.js');
const COMMANDS = ['ducktor.refresh', 'ducktor.openFile', 'ducktor.openSymbol', 'ducktor.openExternal'];

function escapeText(text) {
  return text.replace(/([\\`*_{}\[\]<>()!#|~])/g, '\\$1');
}

function commandLink(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function parseDiagram(source) {
  const mappings = [];
  const lines = source.split(/\r?\n/).filter(line => {
    const match = /^\s*%%\s+ducktor-link\s+(.+)$/.exec(line);
    if (!match) return true;
    const value = JSON.parse(match[1]);
    if (!value || typeof value.node !== 'string' || !/^[\w-]+$/.test(value.node) || typeof value.target !== 'string' || !/^.+#\d+(?:-\d+)?$/.test(value.target) || /(?:^[a-z][\w+.-]*:|[<>\x00-\x1f])/i.test(value.target)) {
      throw new Error('Invalid ducktor-link: expected a node ID and a source file#line target.');
    }
    if (mappings.some(item => item.node === value.node)) throw new Error(`Duplicate ducktor-link node: ${value.node}`);
    mappings.push({ node: value.node, target: value.target });
    return false;
  });
  const text = lines.join('\n');
  const declaration = lines.find(line => line.trim() && !line.trim().startsWith('%%'))?.trim() || '';
  if (!/^(?:flowchart\b|graph\b|classDiagram\b|sequenceDiagram\b|stateDiagram(?:-v2)?\b)/.test(declaration)) {
    throw new Error('Supported diagrams: flowchart, classDiagram, sequenceDiagram and stateDiagram-v2.');
  }
  if (/^\s*---|%%\s*\{|\b(?:click|href|https?:|javascript:|data:|file:|image:|img\b|icon:)\b|<\/?[a-z!]/im.test(text)) {
    throw new Error('Diagram configuration, HTML, external resources and native links are not supported.');
  }
  return { source: text, mappings };
}

async function renderMarkdown(content, resolveLink, { hover = false, heading = true, diagramLinks, resolveDiagramLink } = {}) {
  async function link(label, target, shortcut = false) {
    const destination = await resolveLink(target, shortcut);
    return destination ? `[${label}](${destination})` : label;
  }
  async function text(value) {
    const pattern = /\{!(red|blue|green|orange|yellow|gray)\s+([^{}]+)\}|\{_([^{}]+)\}|\[([^\[\]\n]+)\]|<([^<>\n]+)>/g;
    let result = '', offset = 0;
    for (const match of value.matchAll(pattern)) {
      result += escapeText(value.slice(offset, match.index));
      if (match[1] || match[3]) {
        const body = escapeText(match[2] || match[3]);
        result += hover ? body : `<span class="ducktor-${match[1] ? `color-${match[1]}` : 'underline'}">${body}</span>`;
      }
      else result += await link(escapeText(match[4] || match[5]), match[4] || match[5], true);
      offset = match.index + match[0].length;
    }
    return result + escapeText(value.slice(offset));
  }
  async function tokens(items, listDepth = 0) {
    let result = '';
    for (const token of items || []) {
      switch (token.type) {
        case 'space': result += '\n'; break;
        case 'text': result += token.tokens ? await tokens(token.tokens, listDepth) : await text(token.raw || token.text); break;
        case 'paragraph': result += `${await tokens(token.tokens, listDepth)}\n\n`; break;
        case 'heading': result += `${'#'.repeat(Math.min(token.depth, 4))} ${await tokens(token.tokens, listDepth)}\n\n`; break;
        case 'strong': result += `**${await tokens(token.tokens, listDepth)}**`; break;
        case 'em': result += `*${await tokens(token.tokens, listDepth)}*`; break;
        case 'del': result += `~~${await tokens(token.tokens, listDepth)}~~`; break;
        // marked 已对 codespan.text 做 HTML 转义，重建 Markdown 时保留原始代码。
        case 'codespan': result += token.raw; break;
        case 'code': {
          if (diagramLinks && token.lang?.toLowerCase() === 'mermaid') {
            try {
              const diagram = parseDiagram(token.text);
              const bindings = [];
              for (const mapping of diagram.mappings) {
                const href = await resolveDiagramLink(mapping.target);
                if (href) bindings.push({ node: mapping.node, href });
              }
              diagramLinks.push({ raw: token.text, source: diagram.source, bindings });
            } catch (error) { diagramLinks.push({ raw: token.text, error: error.message }); }
          }
          const fence = '`'.repeat(Math.max(2, ...Array.from(token.text.matchAll(/`+/g), match => match[0].length)) + 1);
          result += `${fence}${(token.lang || '').replace(/[^\w+-]/g, '')}\n${token.text}\n${fence}\n\n`; break;
        }
        case 'blockquote': result += (await tokens(token.tokens, listDepth)).trimEnd().split('\n').map(line => `> ${line}`).join('\n') + '\n\n'; break;
        case 'list': {
          if (hover) {
            // Hover 的宿主样式可能隐藏原生列表标记，改用不会被 CSS 去掉的正文字符。
            result += '\n\n';
            for (let i = 0; i < token.items.length; i++) {
              const marker = token.ordered ? `${Number(token.start) + i}\\. ` : '• ';
              const itemTokens = token.items[i].tokens;
              const body = (await tokens(itemTokens, listDepth + 1)).trimEnd();
              const separator = ['code', 'blockquote', 'heading', 'hr', 'list'].includes(itemTokens[0]?.type) ? '\n\n' : '';
              result += '\u00a0'.repeat(listDepth * 2) + marker + separator + body + '\n\n';
            }
            break;
          }
          for (let i = 0; i < token.items.length; i++) {
            const marker = token.ordered ? `${Number(token.start) + i}. ` : '- ';
            const lines = (await tokens(token.items[i].tokens)).trimEnd().split('\n');
            result += marker + lines[0] + '\n' + lines.slice(1).map(line => ' '.repeat(marker.length) + line + '\n').join('');
          }
          result += '\n'; break;
        }
        case 'link': result += await link(await tokens(token.tokens, listDepth), token.href); break;
        case 'image': result += escapeText(token.text || ''); break;
        case 'html': result += await text(token.raw); break;
        case 'escape': result += escapeText(token.raw.slice(1)); break;
        case 'br': result += '  \n'; break;
        case 'hr': result += '\n---\n\n'; break;
        default: result += escapeText(token.raw || token.text || '');
      }
    }
    return result;
  }
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim());
  if (heading && first >= 0 && !/^\s*(?:`{3,}|~{3,})/.test(lines[first])) {
    lines[first] = `# ${lines[first].trim().replace(/^#{1,6}\s+/, '')}`;
    lines.splice(first + 1, 0, '');
  }
  return tokens(marked.lexer(lines.join('\n'), { gfm: true }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderPanelMarkdown(markdown, links, { diagrams = [] } = {}) {
  const renderer = new marked.Renderer();
  let diagramIndex = 0;
  renderer.code = (code, language) => {
    if (language?.toLowerCase() === 'mermaid' && diagrams.length) {
      const diagram = diagrams[diagramIndex++];
      if (diagram && diagram.raw === code) {
        if (diagram.error) return `<p class="diagram-error">${escapeHtml(diagram.error)}</p><pre><code>${escapeHtml(code)}</code></pre>`;
        const bindings = diagram.bindings.map(binding => {
          const id = String(links.size);
          links.set(id, binding.href);
          return { node: binding.node, link: id };
        });
        return `<div class="ducktor-diagram" data-bindings="${escapeHtml(JSON.stringify(bindings))}" data-diagram-source="${escapeHtml(diagram.source)}"><pre><code>${escapeHtml(code)}</code></pre></div>`;
      }
    }
    return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code)}</code></pre>`;
  };
  renderer.html = html => /^(?:<span class="ducktor-(?:color-(?:red|blue|green|orange|yellow|gray)|underline)">|<\/span>)$/.test(html) ? html : escapeHtml(html);
  renderer.image = (_href, _title, text) => escapeHtml(text || '');
  renderer.link = (href, _title, text) => {
    if (!href.startsWith('command:')) return text;
    const id = String(links.size);
    links.set(id, href);
    return `<a href="#" data-link="${id}">${text}</a>`;
  };
  return marked.parse(markdown, { renderer, gfm: true });
}

function renderSourceLines(source, languageId) {
  source = source.replace(/\r\n?/g, '\n');
  const aliases = { javascriptreact: 'javascript', typescriptreact: 'typescript', shellscript: 'bash', vue: 'xml' };
  const language = aliases[languageId] || languageId;
  if (!language || !hljs.getLanguage(language)) return source.split('\n').map(escapeHtml);
  const html = hljs.highlight(source, { language, ignoreIllegals: true }).value;
  const lines = [];
  const spans = [];
  let line = '';
  // 高亮整份源码后在换行处闭合并重开 span，让多行 token 在每行内保持完整。
  for (const token of html.match(/<span\b[^>]*>|<\/span>|\n|[^<\n]+/g) || []) {
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(spans.length));
      line = spans.join('');
    } else {
      if (token.startsWith('<span')) spans.push(token);
      else if (token === '</span>') spans.pop();
      line += token;
    }
  }
  lines.push(line + '</span>'.repeat(spans.length));
  return lines;
}

module.exports = { COMMANDS, escapeText, commandLink, renderMarkdown, renderPanelMarkdown, escapeHtml, renderSourceLines };
