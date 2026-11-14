import { useEffect, useRef, useState } from "react";
import { Cabecalho } from "../components/pequenos";

interface Passo {
  titulo: string;
  texto: string;
  terminal: { titulo: string; linhas: Array<{ tipo: "cmd" | "ok" | "nota" | "ia"; texto: string }> };
}

const PASSOS: Passo[] = [
  {
    titulo: "Assinatura, não API",
    texto:
      "Os agentes são o Claude Code, o Antigravity e outras CLIs, já logadas na sua assinatura. O Cyno tira do ambiente de cada processo as chaves de provedores e para o terminal se a CLI tentar usar uma.",
    terminal: {
      titulo: "agente Lia · terminal de fundo",
      linhas: [
        { tipo: "cmd", texto: "claude" },
        { tipo: "ok", texto: "ambiente limpo: nenhuma chave de API" },
        { tipo: "ok", texto: "usando a assinatura logada" },
        { tipo: "nota", texto: "se a CLI pedir uma chave, o Cyno para o terminal" },
      ],
    },
  },
  {
    titulo: "Falam por um MCP próprio",
    texto:
      "Os agentes conversam com o app por um servidor MCP do Cyno: pegam tarefas, entregam resultados, pedem a sua aprovação e leem e gravam notas no Cérebro. Cada um é um terminal que você abre e acompanha ao vivo.",
    terminal: {
      titulo: "agente Lia · MCP do Cyno",
      linhas: [
        { tipo: "cmd", texto: "get_task" },
        { tipo: "ia", texto: "Revisar o texto da página de preços" },
        { tipo: "cmd", texto: "report_progress" },
        { tipo: "cmd", texto: "request_approval" },
        { tipo: "nota", texto: "esperando você aprovar no escritório" },
      ],
    },
  },
  {
    titulo: "Um Maestro por workspace",
    texto:
      "Você pede algo ao Maestro. Ele cria o projeto, divide em tarefas, escolhe o time e revisa o que volta. Cada workspace tem escritório, projetos, Cérebro e fila próprios, isolados dos outros.",
    terminal: {
      titulo: "Maestro · workspace Blog",
      linhas: [
        { tipo: "ia", texto: "Quero uma série de 3 posts sobre o lançamento." },
        { tipo: "ok", texto: "projeto criado: Série do lançamento" },
        { tipo: "ok", texto: "3 tarefas, time de redação escolhido" },
        { tipo: "nota", texto: "revisão do Maestro quando as tarefas voltarem" },
      ],
    },
  },
];

const PREFIXO = { cmd: "›", ok: "✓", nota: "·", ia: "“" } as const;

export function ComoFunciona() {
  const [ativo, setAtivo] = useState(0);
  const refs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const olho = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) if (e.isIntersecting) setAtivo(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-40% 0px -40% 0px" },
    );
    for (const el of refs.current) if (el) olho.observe(el);
    return () => olho.disconnect();
  }, []);

  const passo = PASSOS[ativo] ?? PASSOS[0];
  return (
    <section className="secao" id="como-funciona" aria-labelledby="t-como">
      <div className="wrap">
        <Cabecalho rotulo="Como funciona" titulo={<span id="t-como">Agentes de verdade, sem pagar por chamada.</span>}>
          Nada de API paga e nada de agente de mentira: o que o mapa mostra é o que cada terminal está fazendo.
        </Cabecalho>
        <div className="passos-grade">
          <ol className="passos">
            {PASSOS.map((p, i) => (
              <li key={p.titulo} data-i={i} ref={(el) => void (refs.current[i] = el)} className={i === ativo ? "ativo" : ""}>
                <span className="numero pixel" aria-hidden="true">
                  0{i + 1}
                </span>
                <h3>{p.titulo}</h3>
                <p>{p.texto}</p>
              </li>
            ))}
          </ol>
          <div className="terminal" aria-hidden="true">
            <div className="terminal-barra">
              <span className="janela-pontos">
                <i />
                <i />
                <i />
              </span>
              <span>{passo?.terminal.titulo}</span>
            </div>
            <div className="terminal-corpo" key={ativo}>
              {passo?.terminal.linhas.map((l, i) => (
                <p key={i} className={`t-${l.tipo}`} style={{ "--i": i } as React.CSSProperties}>
                  <b>{PREFIXO[l.tipo]}</b> {l.texto}
                  {l.tipo === "ia" ? "”" : ""}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
