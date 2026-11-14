import { GITHUB, Logo } from "../components/pequenos";

const BASE = `${GITHUB}/blob/main`;

const SITE = [
  ["Como funciona", "#como-funciona"],
  ["Aprovação", "#aprovacao"],
  ["O que tem", "#o-que-tem"],
  ["Instalar", "#instalar"],
  ["Dúvidas", "#faq"],
  ["Contribuir", "#contribuir"],
] as const;

const DOCS = [
  ["Usando o escritório", `${BASE}/docs/usando-o-escritorio.md`],
  ["Como rodar", `${BASE}/docs/como-rodar.md`],
  ["Arquitetura", `${BASE}/docs/arquitetura.md`],
  ["Criar agentes e workspaces", `${BASE}/docs/como-criar-agentes-e-workspaces.md`],
  ["Decisões e limitações", `${BASE}/docs/decisoes-e-limitacoes.md`],
  ["CHANGELOG", `${BASE}/CHANGELOG.md`],
] as const;

const PROJETO = [
  ["Código no GitHub", GITHUB],
  ["Como contribuir", `${BASE}/CONTRIBUTING.md`],
  ["Issues", `${GITHUB}/issues`],
  ["Segurança", `${BASE}/SECURITY.md`],
  ["Código de Conduta", `${BASE}/CODE_OF_CONDUCT.md`],
] as const;

function Coluna({ titulo, itens, externo }: { titulo: string; itens: ReadonlyArray<readonly [string, string]>; externo?: boolean }) {
  return (
    <nav className="rodape-col" aria-label={titulo}>
      <h2>{titulo}</h2>
      <ul>
        {itens.map(([nome, href]) => (
          <li key={nome}>
            <a href={href} {...(externo ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {nome}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Rodape() {
  return (
    <footer className="rodape">
      <div className="wrap">
        <div className="rodape-topo">
          <div className="rodape-sobre">
            <div className="rodape-marca">
              <Logo tamanho={24} />
              <span>Cyno</span>
            </div>
            <p>Um escritório de agentes de IA, de código aberto, que roda na sua máquina e na sua assinatura.</p>
          </div>
          <Coluna titulo="Nesta página" itens={SITE} />
          <Coluna titulo="Documentação" itens={DOCS} externo />
          <Coluna titulo="O projeto" itens={PROJETO} externo />
        </div>
        <div className="rodape-base">
          <p>
            Distribuído sob a{" "}
            <a href={`${BASE}/LICENSE`} target="_blank" rel="noopener noreferrer">
              licença MIT
            </a>
            .
          </p>
          <p className="credito">
            O motor de cena e a arte do mapa vêm do projeto de código aberto{" "}
            <a href="https://github.com/marmottajr/habblaud" target="_blank" rel="noopener noreferrer">
              Habblaud
            </a>
            , de Márcio Junior, sob licença MIT, copiados e adaptados no Cyno. Texto da licença original em{" "}
            <a href="/licencas/cena-LICENSE.txt">/licencas/cena-LICENSE.txt</a>.
          </p>
        </div>
      </div>
    </footer>
  );
}
