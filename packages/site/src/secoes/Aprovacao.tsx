// O ciclo de aprovação ("Para você"), com prints reais da tela Aprovações do app de laboratório (public/img/aprovacoes-*.webp, dados fabricados).
import { Cabecalho, ImagemAmpliavel, Revela } from "../components/pequenos";

const PASSOS = [
  {
    t: "O agente pede",
    d: "Cada pedido vira um item em Aprovações, com tipo, agente, motivo e, se houver, o contexto que ele analisou.",
  },
  {
    t: "Você decide",
    d: "Aprove, edite o texto (o contador mostra o limite do tipo), responda a uma pergunta ou recuse. Aprovar faz a tarefa seguir com o texto final.",
  },
  {
    t: "Recusar pede o motivo",
    d: "Escolha uma categoria (texto, tom, fato errado, formato, fora do pedido) e escreva o motivo. Com ele, o texto volta ao mesmo agente, até 2 vezes; sem ele, o Maestro decide.",
  },
  {
    t: "Em lote, quando fizer sentido",
    d: "Até 20 itens do mesmo tipo de uma vez, com o texto de cada um à vista. Convite e post só entram depois de você aprovar um do mesmo agente e tipo.",
  },
];

const PRINTS = [
  {
    src: "/img/aprovacoes-lista.webp",
    largura: 1188,
    altura: 1812,
    alt: "Lista de Aprovações com quatro itens esperando: um post, um comentário, um convite e uma pergunta, de agentes diferentes.",
    legenda: "Itens de tipos e agentes diferentes, esperando você.",
  },
  {
    src: "/img/aprovacoes-cartao.webp",
    largura: 1626,
    altura: 2502,
    alt: "Cartão de um post para o feed do LinkedIn: o motivo do pedido, o texto editável com o contador de caracteres, a nota para o time e os botões Copiar texto, Recusar e Aprovar.",
    legenda: "O texto que vai sair, editável, com contador e nota para o time.",
  },
  {
    src: "/img/aprovacoes-recusa.webp",
    largura: 1626,
    altura: 3342,
    alt: "Cartão de um comentário com o contexto do post original e, embaixo, o campo Por que está recusando?, com as categorias Texto, Tom, Fato errado, Formato, Fora do pedido e Outro, e o motivo digitado.",
    legenda: "Ao recusar, o motivo vai junto e o agente refaz.",
  },
] as const;

export function Aprovacao() {
  return (
    <section className="secao secao-compacta" id="aprovacao" aria-labelledby="t-aprovacao">
      <div className="wrap">
        <Cabecalho rotulo="Aprovação" titulo={<span id="t-aprovacao">Quando o agente precisa de você, chega um cartão.</span>}>
          O que depende de uma decisão sua fica junto, em um lugar só. O contador aparece na barra, no título da aba e, se você ligar, como notificação com o
          site fechado.
        </Cabecalho>
        <Revela>
          <ol className="aprov-passos">
            {PASSOS.map((p, i) => (
              <li key={p.t}>
                <span className="pixel" aria-hidden="true">
                  0{i + 1}
                </span>
                <div>
                  <h3>{p.t}</h3>
                  <p>{p.d}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="aprov-prints">
            {PRINTS.map((p) => (
              <figure key={p.src} className="tela aprov-tela">
                <ImagemAmpliavel src={p.src} alt={p.alt} largura={p.largura} altura={p.altura} legenda={p.legenda} />
              </figure>
            ))}
          </div>
          <p className="aprov-nota">Prints da tela Aprovações, no app de laboratório (dados fabricados).</p>
        </Revela>
      </div>
    </section>
  );
}
