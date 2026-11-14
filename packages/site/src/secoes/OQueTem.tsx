import { Cabecalho, Revela } from "../components/pequenos";

interface Print {
  src: string;
  alt: string;
  largura: number;
  altura: number;
}

function Tela({ p }: { p: Print }) {
  return (
    <figure className="tela">
      <img src={p.src} width={p.largura} height={p.altura} loading="lazy" decoding="async" alt={p.alt} />
    </figure>
  );
}

const CIDADE: Print = {
  src: "/img/cidade.webp",
  largura: 2160,
  altura: 1350,
  alt: "A página do Cyno: a cidade com os prédios dos workspaces, a conversa com o assistente e o resumo do que espera aprovação.",
};
const GESTAO: Print = {
  src: "/img/gestao.webp",
  largura: 2160,
  altura: 945,
  alt: "Gestão: painel da semana com entregas, tempo até entregar, gasto equivalente e previsão de prazos.",
};
const PROJETOS: Print = {
  src: "/img/projetos.webp",
  largura: 2160,
  altura: 945,
  alt: "Projetos e tarefas: lista de projetos com progresso, agentes responsáveis, prazo e prioridade.",
};

const PEQUENOS = [
  { t: "Para você", d: "Tudo que precisa do seu OK, com o texto editável antes de sair." },
  { t: "Rotinas e Calendário", d: "Trabalhos recorrentes e a agenda do workspace." },
  { t: "Cérebro", d: "Notas em Markdown por sala e globais, que os agentes leem e escrevem." },
  { t: "Biblioteca", d: "Apps, conectores MCP, skills e mídia, com ferramentas próprias por agente." },
  { t: "Gastos", d: "Consumo por agente e por workspace, em equivalente à API." },
  { t: "Terminal de cada agente", d: "Abra qualquer um e veja o trabalho ao vivo." },
];

export function OQueTem() {
  return (
    <section className="secao" id="o-que-tem" aria-labelledby="t-tem">
      <div className="wrap">
        <Cabecalho rotulo="O que tem" titulo={<span id="t-tem">Tudo que um escritório tem. Menos a reunião.</span>}>
          Um app web para pedir, acompanhar e aprovar. Os prints são do app, com dados fabricados.
        </Cabecalho>

        <Revela>
          <div className="bento">
            <article className="cartao cartao-grande">
              <div className="cartao-texto">
                <h3>A cidade dos workspaces</h3>
                <p>
                  Acima de todos os workspaces fica o Cyno, o assistente que escolhe para onde cada pedido vai. A cidade mostra um prédio por workspace, quantos
                  agentes trabalham e o que espera você.
                </p>
              </div>
              <Tela p={CIDADE} />
            </article>
            <article className="cartao">
              <Tela p={GESTAO} />
              <div className="cartao-texto">
                <h3>Gestão</h3>
                <p>Painel da semana, previsões de prazo, pessoas, relatórios e metas. Tudo calculado por código, sem gastar IA.</p>
              </div>
            </article>
            <article className="cartao">
              <Tela p={PROJETOS} />
              <div className="cartao-texto">
                <h3>Projetos, sprints e tarefas</h3>
                <p>Lista e quadro, prazos, dependências e um agendador que escolhe o próximo trabalho sem gastar IA.</p>
              </div>
            </article>
          </div>
        </Revela>

        <Revela>
          <ul className="pequenos">
            {PEQUENOS.map((p) => (
              <li key={p.t}>
                <h3>{p.t}</h3>
                <p>{p.d}</p>
              </li>
            ))}
          </ul>
        </Revela>
      </div>
    </section>
  );
}
