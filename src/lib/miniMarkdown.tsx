import React from 'react';

// Just enough Markdown for Ask ProfixBook's answers: headings, paragraphs,
// **bold**, *italic*, `code`, bullet and numbered lists, and pipe tables.
// Builds React elements directly, never HTML strings, so nothing a model
// writes can inject markup or script into the page.

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'table'; head: string[]; rows: string[][] };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const bullet = /^\s*[-*•]\s+(.*)$/;
const numbered = /^\s*(\d+)[.)]\s+(.*)$/;
const heading = /^\s*(#{1,6})\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: 'p', text: para.join('\n') }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }

    const h = line.match(heading);
    if (h) { flush(); out.push({ kind: 'h', level: h[1].length, text: h[2] }); continue; }

    // A table needs a header row immediately followed by a separator row.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      i--;
      out.push({ kind: 'table', head, rows });
      continue;
    }

    const b = line.match(bullet);
    if (b) {
      flush();
      const items = [b[1]];
      while (i + 1 < lines.length && bullet.test(lines[i + 1])) items.push(lines[++i].match(bullet)![1]);
      out.push({ kind: 'ul', items });
      continue;
    }

    const n = line.match(numbered);
    if (n) {
      flush();
      const items = [n[2]];
      while (i + 1 < lines.length && numbered.test(lines[i + 1])) items.push(lines[++i].match(numbered)![2]);
      out.push({ kind: 'ol', items, start: Number(n[1]) });
      continue;
    }

    para.push(line);
  }
  flush();
  return out;
}

// **bold**, __bold__, *italic*, _italic_, `code`. Anything unmatched stays literal.
export function renderInline(text: string, keyPrefix = ''): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}i${k++}`;
    if (m[2] ?? m[3]) out.push(<strong key={key}>{m[2] ?? m[3]}</strong>);
    else if (m[4]) out.push(<code key={key}>{m[4]}</code>);
    else out.push(<em key={key}>{m[5] ?? m[6]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function MiniMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case 'h': return <p key={k} className="md-h">{renderInline(b.text, k)}</p>;
          case 'p': return <p key={k}>{b.text.split('\n').flatMap((ln, j) => j ? [<br key={`${k}br${j}`} />, ...renderInline(ln, `${k}l${j}`)] : renderInline(ln, `${k}l${j}`))}</p>;
          case 'ul': return <ul key={k}>{b.items.map((it, j) => <li key={j}>{renderInline(it, `${k}${j}`)}</li>)}</ul>;
          case 'ol': return <ol key={k} start={b.start}>{b.items.map((it, j) => <li key={j}>{renderInline(it, `${k}${j}`)}</li>)}</ol>;
          case 'table': return (
            <div key={k} className="md-table">
              <table>
                <thead><tr>{b.head.map((c, j) => <th key={j}>{renderInline(c, `${k}h${j}`)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{renderInline(c, `${k}${j}-${x}`)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
