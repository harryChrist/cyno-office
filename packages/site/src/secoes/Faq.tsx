import type { ReactNode } from "react";
import { Cabecalho, Revela } from "../components/pequenos";

const PERGUNTAS: Array<{ p: string; r: ReactNode }> = [
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
  {
    p: "O que o Cyno gasta, e o que mostra de custo?",
    r: "Os agentes gastam a cota da assinatura da CLI de cada um. A aba Gastos mostra o equivalente na API, não o que você paga. Dá para definir orçamento por dia, semana e mês; o Cyno só avisa ao chegar em 80% e em 100%, e nunca trava nem para o trabalho.",
  },
  {
    p: "Algum dado sai do computador por outro caminho?",
    r: "Em dois casos. O Freebuff manda o que o agente lê para os servidores da Codebuff. E o OpenClaw e o Hermes, se você usar a chave do OpenRouter, rodam os modelos de lá. Nos demais, quem fala com o provedor é a CLI do agente, como faria sem o Cyno.",
  },
  {
    p: "O que o Cyno ainda não faz?",
    r: (
      <ul className="faq-lista">
        <li>O progresso de uma tarefa em andamento não sobrevive a reiniciar o servidor: uma aprovação pendente volta com 0% e uma mensagem genérica, mas aprovar e recusar funcionam.</li>
        <li>Cada aba do navegador tem a própria simulação do mapa: o status é o mesmo, mas a posição de um agente ocioso pode mudar de uma aba para outra.</li>
        <li>A posição de uma sala no grid e a sala de um time inteiro só mudam pela API.</li>
        <li>O Hermes só foi lido no código-fonte, sem teste com o programa instalado, e no OpenClaw o formato de um turno bem-sucedido ainda não foi conferido.</li>
        <li>A cerca de arquivos do OpenClaw e do Hermes usa o Landlock do Linux. Sem ele, os agentes rodam sem a cerca e o app avisa.</li>
      </ul>
    ),
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
                {typeof q.r === "string" ? <p>{q.r}</p> : <div className="faq-resp">{q.r}</div>}
              </details>
            ))}
          </div>
        </Revela>
      </div>
    </section>
  );
}
