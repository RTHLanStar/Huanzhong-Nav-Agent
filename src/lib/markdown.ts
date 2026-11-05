function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderInline(text: string): string {
  let output = escapeHtml(text);
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return output;
}

/**
 * 轻量 Markdown 渲染：仅覆盖标题、列表、代码块、引用、表格与常用行内语法。
 * 所有原始 HTML 均先转义，避免预览时执行不受信任内容。
 */
export function renderMarkdown(source: string): string {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]) => {
    if (!buffer.length) return;
    html.push(`<p>${renderInline(buffer.join(' '))}</p>`);
    buffer.length = 0;
  };

  const paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index];

    if (/^```/.test(line)) {
      flushParagraph(paragraph);
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(
        `<pre class="md-code"${language ? ` data-lang="${escapeHtml(language)}"` : ''}><code>${escapeHtml(
          code.join('\n'),
        )}</code></pre>`,
      );
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph(paragraph);
      html.push('<hr />');
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${quote.map((item) => renderInline(item)).join('<br />')}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    // 表格：表头 + 分隔行
    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      flushParagraph(paragraph);
      const split = (row: string) =>
        row
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const headers = split(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /\|/.test(lines[index]) && !/^\s*$/.test(lines[index])) {
        rows.push(split(lines[index]));
        index += 1;
      }
      html.push(
        `<table class="md-table"><thead><tr>${headers
          .map((cell) => `<th>${renderInline(cell)}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph(paragraph);
  return html.join('\n');
}
