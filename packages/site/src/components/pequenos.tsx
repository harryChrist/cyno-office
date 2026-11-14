import { useEffect, useRef, useState, type ReactNode } from "react";

export const GITHUB = "https://github.com/harryChrist/cyno-office";

/** O logo do Cyno: o único lugar que sabe qual arquivo é (public/brand/). Trocar o logo é trocar o arquivo. */
export function Logo({ tamanho = 28 }: { tamanho?: number }) {
  return <img src="/brand/cyno-mark.svg" alt="" width={tamanho} height={tamanho} />;
}

export function IconeGitHub() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Seta() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

/** Copia o texto para a área de transferência; sem permissão, seleciona para o Ctrl+C. */
export function BotaoCopiar({ texto, alvo, rotulo = "Copiar" }: { texto: string; alvo?: React.RefObject<HTMLElement | null>; rotulo?: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const aoClicar = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(texto);
      ok = true;
    } catch {
      const el = alvo?.current;
      if (el) {
        const faixa = document.createRange();
        faixa.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(faixa);
      }
    }
    setMsg(ok ? "Copiado" : "Selecionado: use Ctrl+C");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2200);
  };
  return (
    <button type="button" className="copiar" onClick={aoClicar}>
      {msg ?? rotulo}
      <span className="so-leitor" role="status" aria-live="polite">
        {msg ?? ""}
      </span>
    </button>
  );
}

export function Cabecalho({ rotulo, titulo, children }: { rotulo: string; titulo: ReactNode; children?: ReactNode }) {
  return (
    <header className="cab">
      <p className="rotulo">{rotulo}</p>
      <h2>{titulo}</h2>
      {children ? <p className="intro">{children}</p> : null}
    </header>
  );
}

/** Revela o conteúdo ao entrar na tela (só quando há JS e o movimento não está reduzido; o CSS cuida do resto). */
export function Revela({ children, atraso = 0, className = "" }: { children: ReactNode; atraso?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visto, setVisto] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const olho = new IntersectionObserver(
      (e) => {
        if (e.some((x) => x.isIntersecting)) {
          setVisto(true);
          olho.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    olho.observe(el);
    return () => olho.disconnect();
  }, []);
  return (
    <div ref={ref} className={`revela${visto ? " visto" : ""} ${className}`} style={{ "--atraso": `${atraso}ms` } as React.CSSProperties}>
      {children}
    </div>
  );
}
