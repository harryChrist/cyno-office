import { useCallback, useEffect, useRef, useState } from "react";
import type { DemoMontada } from "../cena/montarDemo";

type Estado = "espera" | "carregando" | "ligada" | "erro";

const CONSULTA_CELULAR = "(max-width: 899px)";
const CONSULTA_MOVIMENTO = "(prefers-reduced-motion: reduce)";

/**
 * O mapa vivo: um escritório de demonstração rodando de verdade (motor @cyno/cena, dados fabricados no navegador).
 * O print (poster) fica sempre por baixo e é tudo que aparece com `prefers-reduced-motion` e no celular, onde a
 * cena só liga se a pessoa pedir. Em tela grande, liga sozinha quando o mapa se aproxima da tela.
 */
export function Mapa() {
  const caixa = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const demo = useRef<DemoMontada | null>(null);
  const [estado, setEstado] = useState<Estado>("espera");
  const [automatico] = useState(() => !window.matchMedia(CONSULTA_MOVIMENTO).matches && !window.matchMedia(CONSULTA_CELULAR).matches);

  const ligar = useCallback(() => {
    setEstado((atual) => (atual === "espera" || atual === "erro" ? "carregando" : atual));
  }, []);

  // Liga sozinha, em tela grande, quando o mapa chega perto da área visível.
  useEffect(() => {
    const el = caixa.current;
    if (!automatico || !el) return;
    const olho = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((e) => e.isIntersecting)) {
          ligar();
          olho.disconnect();
        }
      },
      { rootMargin: "300px 0px" },
    );
    olho.observe(el);
    return () => olho.disconnect();
  }, [automatico, ligar]);

  // Carrega o motor (chunk próprio) e monta no canvas.
  const montar = estado === "carregando" || estado === "ligada";
  useEffect(() => {
    if (!montar) return;
    const elCanvas = canvas.current;
    if (!elCanvas) return;
    let vivo = true;
    let montada: DemoMontada | null = null;
    import("../cena/montarDemo")
      .then((modulo) => {
        if (!vivo) return;
        montada = modulo.montarDemo(elCanvas);
        demo.current = montada;
        setEstado("ligada");
      })
      .catch(() => vivo && setEstado("erro"));
    return () => {
      vivo = false;
      montada?.desmontar();
      demo.current = null;
    };
  }, [montar]);

  // Com a cena ligada: para de desenhar fora da tela, não rouba a roda do mouse (só com Ctrl) nem o teclado da página.
  useEffect(() => {
    const el = caixa.current;
    if (estado !== "ligada" || !el) return;
    const olho = new IntersectionObserver((entradas) => demo.current?.suspender(!entradas.some((e) => e.isIntersecting)));
    olho.observe(el);
    const aoRolar = (e: WheelEvent) => {
      if (!e.ctrlKey) e.stopPropagation();
    };
    const aoTeclar = (e: KeyboardEvent) => {
      if (!(e.target instanceof Node) || !el.contains(e.target)) e.stopPropagation();
    };
    el.addEventListener("wheel", aoRolar, { capture: true });
    window.addEventListener("keydown", aoTeclar, { capture: true });
    return () => {
      olho.disconnect();
      el.removeEventListener("wheel", aoRolar, { capture: true });
      window.removeEventListener("keydown", aoTeclar, { capture: true });
    };
  }, [estado]);

  const aoVivo = estado === "ligada";
  return (
    <div className="janela" id="mapa">
      <div className="janela-barra">
        <span className="janela-pontos" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="janela-titulo">Escritório de demonstração</span>
        <span className={`janela-estado${aoVivo ? " ligado" : ""}`}>{aoVivo ? "ao vivo" : estado === "carregando" ? "ligando…" : "parado"}</span>
      </div>
      <div
        ref={caixa}
        className="mapa"
        tabIndex={aoVivo ? 0 : -1}
        role="img"
        aria-label="Escritório do Cyno em pixel art, com agentes andando, sentando para trabalhar e pedindo aprovação. É uma demonstração com dados de mentira."
      >
        <img className="mapa-poster" src="/img/mapa.webp" width="1238" height="697" alt="" fetchPriority="high" />
        <canvas ref={canvas} className={`mapa-canvas${aoVivo ? " pronto" : ""}`} />
        {estado === "espera" || estado === "erro" ? (
          <button type="button" className="btn btn-primario mapa-ligar" onClick={ligar}>
            {estado === "erro" ? "Tentar ligar de novo" : "Ligar o escritório ao vivo"}
          </button>
        ) : null}
        {estado === "carregando" ? <p className="mapa-aviso">Carregando o motor de cena…</p> : null}
      </div>
      <div className="janela-pe">
        <p>
          Tudo aqui é fabricado dentro desta página: nenhum servidor, nenhum dado real. {aoVivo ? "Arraste para mover o mapa; Ctrl e a roda aproximam." : ""}
        </p>
        {aoVivo ? (
          <button type="button" className="btn-mini" onClick={() => demo.current?.mundo.overview()}>
            Visão geral
          </button>
        ) : null}
      </div>
    </div>
  );
}
