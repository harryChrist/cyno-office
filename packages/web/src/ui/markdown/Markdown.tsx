import { useMemo, type ReactNode } from "react";
import { headingId, parseMarkdown, type Block, type Inline } from "./markdownTree";

/** Endereço (hash) da nota de um wiki link, ou null se ela não existe no workspace. */
export type WikiResolver = (target: string) => string | null;

/** `idPrefix`: dá âncora (id) aos títulos de primeiro nível, para o sumário apontar para eles. */
type Ctx = { resolveWiki: WikiResolver; headingOffset: number; idPrefix?: string | undefined; plainLinks?: boolean | undefined };

function renderInlines(nodes: Inline[], ctx: Ctx): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "break":
        return <br key={index} />;
      case "code":
        return (
          <code key={index} className="md__code">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderInlines(node.children, ctx)}</strong>;
      case "em":
        return <em key={index}>{renderInlines(node.children, ctx)}</em>;
      case "link":
        // Conteúdo de agente: nada clicável. O endereço fica na dica, para o dono ler e decidir.
        if (ctx.plainLinks) {
          return (
            <span key={index} className="md__link md__link--plain" title={node.href}>
              {renderInlines(node.children, ctx)}
            </span>
          );
        }
        return (
          <a key={index} className="md__link" href={node.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInlines(node.children, ctx)}
          </a>
        );
      case "wiki": {
        const href = ctx.resolveWiki(node.target);
        return href ? (
          <a key={index} className="md__wiki" href={href} data-testid="brain-wiki-link">
            {node.label}
          </a>
        ) : (
          <span key={index} className="md__wiki md__wiki--missing" title={`Nota "${node.target}" não encontrada`} data-testid="brain-wiki-missing">
            {node.label}
          </span>
        );
      }
    }
  });
}

function renderBlocks(blocks: Block[], ctx: Ctx): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, block.level + ctx.headingOffset);
        const Tag = `h${level}` as "h3";
        return (
          <Tag key={index} id={ctx.idPrefix ? headingId(ctx.idPrefix, index) : undefined} className={`md__heading md__heading--${block.level}`}>
            {renderInlines(block.children, ctx)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={index} className="md__p">
            {renderInlines(block.children, ctx)}
          </p>
        );
      case "list": {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {renderInlines(item.children, ctx)}
            {renderBlocks(item.blocks, { ...ctx, idPrefix: undefined })}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} className="md__list" start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index} className="md__list">
            {items}
          </ul>
        );
      }
      case "quote":
        return (
          <blockquote key={index} className="md__quote">
            {renderBlocks(block.blocks, { ...ctx, idPrefix: undefined })}
          </blockquote>
        );
      case "code":
        return (
          <pre key={index} className="md__pre" data-lang={block.lang || undefined}>
            <code>{block.text}</code>
          </pre>
        );
      case "table": {
        const align = (column: number) => (block.align[column] ? { textAlign: block.align[column] } : undefined);
        // A tabela larga rola sozinha (o texto em volta não ganha rolagem lateral).
        return (
          <div key={index} className="md__table-wrap">
            <table className="md__table">
              <thead>
                <tr>
                  {block.head.map((cell, column) => (
                    <th key={column} style={align(column)}>
                      {renderInlines(cell, ctx)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td key={column} style={align(column)}>
                        {renderInlines(cell, ctx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "rule":
        return <hr key={index} className="md__rule" />;
    }
  });
}

/**
 * Markdown renderizado como elementos React (nada de HTML cru: todo texto é escapado pelo
 * React). `headingOffset` desce o nível dos títulos para caber na hierarquia da página;
 * `className` soma uma variante (ex.: "md--compact" nas linhas do tempo).
 */
export function Markdown({
  source,
  resolveWiki,
  headingOffset = 2,
  className,
  testId,
  idPrefix,
  plainLinks,
}: {
  source: string;
  resolveWiki: WikiResolver;
  headingOffset?: number;
  className?: string;
  testId?: string;
  idPrefix?: string;
  /** Link vira texto com o endereço na dica (para o que vem de agente). */
  plainLinks?: boolean;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={className ? `md ${className}` : "md"} data-testid={testId}>
      {renderBlocks(blocks, { resolveWiki, headingOffset, idPrefix, plainLinks })}
    </div>
  );
}
