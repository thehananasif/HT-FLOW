import { useMemo, type ReactNode } from 'react';
import { toast } from '@htflow/ui-kit';
import { parseMarkdown, type Block, type Inline } from './markdown';

function inl(nodes: Inline[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'b':
        return <strong key={k}>{inl(n.c, k)}</strong>;
      case 'i':
        return <em key={k}>{inl(n.c, k)}</em>;
      case 's':
        return <s key={k}>{inl(n.c, k)}</s>;
      case 'a':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {inl(n.c, k)}
          </a>
        );
    }
  });
}

function CodeBlock({ lang, value }: { lang: string; value: string }) {
  const copy = () =>
    navigator.clipboard.writeText(value).then(
      () => toast('success', 'Code copied'),
      () => toast('error', 'Copy failed'),
    );
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang || 'code'}</span>
        <button type="button" onClick={copy} aria-label="Copy code">
          Copy
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'h': {
      const Tag = `h${Math.min(6, b.level + 2)}` as 'h3';
      return <Tag key={i}>{inl(b.c)}</Tag>;
    }
    case 'p':
      return <p key={i}>{inl(b.c)}</p>;
    case 'code':
      return <CodeBlock key={i} lang={b.lang} value={b.v} />;
    case 'ul':
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inl(it)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={i} start={b.start}>
          {b.items.map((it, j) => (
            <li key={j}>{inl(it)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return <blockquote key={i}>{b.c.map(block)}</blockquote>;
    case 'table':
      return (
        <table key={i} className="ai-table">
          <thead>
            <tr>
              {b.head.map((c, j) => (
                <th key={j}>{inl(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, k) => (
                  <td key={k}>{inl(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'hr':
      return <hr key={i} />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="ai-md">{blocks.map(block)}</div>;
}
