import { BOARD_EXAMPLE_CATALOG_HTML, BOARD_EXAMPLE_STUDY_HTML, exampleCatalogData, exampleStudyData } from "@cyno/shared";
import { useMemo } from "react";
import { QuadroFrame, makeDoc } from "./QuadroFrame";
import type { ExampleId } from "./quadroView";

/** Os dois exemplos do estado vazio: dados fictícios que o dono abre ali mesmo para ver como um quadro fica. */
export const EXAMPLES: Record<ExampleId, { title: string; blurb: string; ask: string }> = {
  catalogo: {
    title: "Catálogo de obras",
    blurb: "300 obras com situação, capítulos lidos e busca, filtro e ordem.",
    ask: "Monte um quadro com o catálogo das minhas obras, com status e capítulos.",
  },
  estudos: {
    title: "Acompanhamento de concurso",
    blurb: "Datas importantes, matérias com progresso e o que falta estudar.",
    ask: "Monte um quadro para acompanhar meu concurso, com datas e o que falta estudar.",
  },
};

function exampleDoc(id: ExampleId) {
  const meta = { title: EXAMPLES[id].title, description: EXAMPLES[id].blurb };
  const data = id === "catalogo" ? exampleCatalogData(300) : exampleStudyData();
  const payload = { data, meta };
  return { doc: makeDoc(id === "catalogo" ? BOARD_EXAMPLE_CATALOG_HTML : BOARD_EXAMPLE_STUDY_HTML, payload), payload };
}

/** O estado vazio: o que é o Quadro, como conseguir um e os exemplos. */
export function QuadroEmpty({ onOpenExample }: { onOpenExample: (id: ExampleId) => void }) {
  return (
    <div className="quadro-empty" data-testid="quadro-empty">
      <div className="quadro-empty__intro">
        <p className="quadro-empty__eyebrow">Quadro</p>
        <h2 className="quadro-empty__title">Ainda não há quadros neste workspace</h2>
        <p className="quadro-empty__text">
          O Quadro é um mural para você olhar: os agentes guardam os dados e montam a página que os mostra, do jeito que combina com o assunto. Cada quadro pode ser totalmente diferente do outro, e os números se atualizam sozinhos quando os agentes mexem neles.
        </p>
        <p className="quadro-empty__text">
          Para ter o primeiro, <strong>peça ao Maestro</strong>: &ldquo;monte um quadro para acompanhar...&rdquo; e diga o que quer ver.
        </p>
      </div>
      <h3 className="quadro-empty__sub">Veja como fica</h3>
      <ul className="quadro-examples">
        {(Object.keys(EXAMPLES) as ExampleId[]).map((id) => (
          <li key={id} className="quadro-example" data-testid={`quadro-example-${id}`}>
            <span className="quadro-example__tag">Exemplo</span>
            <h4 className="quadro-example__title">{EXAMPLES[id].title}</h4>
            <p className="quadro-example__blurb">{EXAMPLES[id].blurb}</p>
            <p className="quadro-example__ask">
              Você pediria: <em>{EXAMPLES[id].ask}</em>
            </p>
            <button type="button" className="ui-button ui-button--secondary" onClick={() => onOpenExample(id)} data-testid={`quadro-example-open-${id}`}>
              Abrir o exemplo
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Um exemplo aberto: o mesmo iframe isolado dos quadros de verdade, marcado como exemplo. */
export function QuadroExample({ id, onBack }: { id: ExampleId; onBack: () => void }) {
  const { doc, payload } = useMemo(() => exampleDoc(id), [id]);
  return (
    <div className="quadro-view" data-testid="quadro-example-view">
      <div className="quadro-banner">
        <span className="quadro-example__tag">Exemplo</span>
        <span className="quadro-banner__text">
          <strong>{EXAMPLES[id].title}</strong>: dados inventados, só para mostrar como um quadro fica. Nada disso é seu.
        </span>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onBack} data-testid="quadro-example-back">
          Voltar
        </button>
      </div>
      <div className="quadro-stage">
        <QuadroFrame title={`Exemplo: ${EXAMPLES[id].title}`} doc={doc} payload={payload} testId="quadro-example-frame" />
      </div>
    </div>
  );
}
