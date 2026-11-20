import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { api } from "../../api/client";
import { token, xtermTheme } from "../../agentWork/MaestroTerminal";
import { SCRIPT_POLL_MS, SCRIPT_SCROLLBACK, SCRIPT_TERMINAL_COLS } from "./scriptsView";

/** Esconde o cursor (é só leitura). */
const HIDE_CURSOR = "\u001b[?25l";
/** Espera antes de tentar de novo depois de uma falha de rede. */
const RETRY_MS = 2500;

type Props = {
  workspaceId: string;
  scriptId: string;
  /** Rolar sozinho até o fim a cada trecho novo. */
  follow: boolean;
  /** O usuário rolou para cima: o "Seguir o fim" desliga. */
  onFollowChange: (follow: boolean) => void;
};

/**
 * A saída de um script num xterm de LEITURA: o texto bruto do programa (cores, `\r` de barra de progresso) como o
 * servidor guardou, lido por pedaços (GET .../output?from=<byte>) cerca de uma vez por segundo até o script
 * acabar. As colunas são as do PTY do script (120, no mínimo): telas estreitas rolam para o lado em vez de
 * quebrar as linhas de outro jeito. Trocar de script zera o terminal e lê de novo do começo.
 */
export function ScriptTerminal({ workspaceId, scriptId, follow, onFollowChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const followRef = useRef(follow);
  const followChange = useRef(onFollowChange);
  // Os ouvintes do xterm leem sempre o valor mais novo (sem recriar o terminal).
  useEffect(() => {
    followRef.current = follow;
    followChange.current = onFollowChange;
  });

  // O terminal em si: um por montagem; o tamanho acompanha o espaço (linhas), com 120 colunas no mínimo.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mount = document.createElement("div");
    mount.className = "scripts-term__mount";
    host.append(mount);
    const term = new Terminal({
      fontFamily: token("--ui-font-mono", "ui-monospace, monospace"),
      fontSize: 13,
      lineHeight: 1.2,
      cols: SCRIPT_TERMINAL_COLS,
      rows: 24,
      scrollback: SCRIPT_SCROLLBACK,
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      theme: xtermTheme(),
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount);
    term.write(HIDE_CURSOR);
    termRef.current = term;

    const fitNow = () => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.rows) || size.rows < 2) return;
      const cols = Math.max(SCRIPT_TERMINAL_COLS, Number.isFinite(size.cols) ? size.cols : 0);
      if (cols !== term.cols || size.rows !== term.rows) term.resize(cols, size.rows);
      // A tela passa da largura do painel: o painel rola para o lado (a barra de rolagem do xterm vai junto).
      const screen = mount.querySelector<HTMLElement>(".xterm-screen");
      mount.style.minWidth = screen ? `${screen.offsetWidth + 16}px` : "";
    };
    fitNow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(fitNow, 80);
    });
    observer.observe(host);

    // Rolar para cima desliga o "Seguir o fim" (só se foi o usuário: roda, toque, tecla ou arrasto).
    let intent = 0;
    const markIntent = () => {
      intent = Date.now();
    };
    const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const name of events) host.addEventListener(name, markIntent, { passive: true });
    const offScroll = term.onScroll(() => {
      const buffer = term.buffer.active;
      if (Date.now() - intent < 1500 && buffer.viewportY < buffer.baseY && followRef.current) followChange.current(false);
    });

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      for (const name of events) host.removeEventListener(name, markIntent);
      offScroll.dispose();
      term.dispose();
      termRef.current = null;
      mount.remove();
    };
  }, []);

  // A leitura: do byte 0 até o fim, de novo a cada script (e workspace) novo.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let from = 0;
    term.reset();
    term.write(HIDE_CURSOR);

    const tick = async () => {
      let delay = SCRIPT_POLL_MS;
      try {
        const chunk = await api.getScriptOutput(scriptId, from);
        if (stopped) return;
        if (chunk.data) {
          term.write(chunk.data, () => {
            if (!stopped && followRef.current) term.scrollToBottom();
          });
        }
        from = chunk.next;
        if (chunk.done) return;
        // Ainda tem texto guardado depois deste pedaço: lê o resto já.
        if (chunk.next < chunk.size) delay = 0;
      } catch {
        delay = RETRY_MS;
      }
      if (!stopped) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [workspaceId, scriptId]);

  // Ligou o "Seguir o fim": vai para o fim agora.
  useEffect(() => {
    if (follow) termRef.current?.scrollToBottom();
  }, [follow]);

  return <div ref={hostRef} className="scripts-term" role="log" aria-label="Saída do script" tabIndex={0} data-testid="scripts-terminal" />;
}
