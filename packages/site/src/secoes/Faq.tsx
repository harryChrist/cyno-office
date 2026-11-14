import { Cabecalho, Revela } from "../components/pequenos";

const PERGUNTAS = [
  {
    p: "Preciso de chave de API?",
    r: "Não. Cada agente é uma CLI logada na sua assinatura, como o Claude Code. O Cyno limpa do ambiente de cada processo as variáveis de provedores e para o terminal se a CLI tentar usar uma chave.",
  },
  {
    p: "Meus dados saem do computador?",
    r: "O Cyno guarda tudo em arquivos JSON no seu servidor, sem banco de dados e sem conta. Quem fala com os provedores de IA é a CLI de cada agente, como faria sem o Cyno.",
  },
  {
    p: "Quais agentes funcionam?",
    r: "O Claude Code e o Antigravity, e há adaptadores para outros motores. Para ter agentes de verdade, instale e faça login em ao menos uma CLI.",
  },
  {
    p: "Como entro na primeira vez?",
    r: "Rode npm run auth:code (no Docker, docker compose exec cyno npm run auth:code). O código também aparece no log do servidor. Você digita o código e cria a senha na tela.",
  },
  {
    p: "O mapa deste site é de verdade?",
    r: "O motor de cena é o mesmo do app, mas os agentes daqui são fabricados dentro da página pelo simulador do motor: nenhum servidor, nenhum dado real.",
  },
  {
    p: "Qual é a licença?",
    r: "MIT. O código está no GitHub, e o motor de cena vem do projeto Habblaud, também MIT, com os créditos no rodapé.",
  },
];

export function Faq() {
  return (
    <section className="secao" id="faq" aria-labelledby="t-faq">
      <div className="wrap wrap-estreito">
        <Cabecalho rotulo="Dúvidas" titulo={<span id="t-faq">Perguntas que costumam aparecer.</span>} />
        <Revela>
          <div className="faq">
            {PERGUNTAS.map((q) => (
              <details key={q.p}>
                <summary>{q.p}</summary>
                <p>{q.r}</p>
              </details>
            ))}
          </div>
        </Revela>
      </div>
    </section>
  );
}
