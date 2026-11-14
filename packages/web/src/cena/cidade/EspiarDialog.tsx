// "Espiar": o escritório de um workspace, só para olhar. Uma segunda cena (canvas próprio, sem painéis nem ações:
// nenhuma interface do Cyno é ligada a ela) alimentada pelo socket próprio daquele workspace (`fontesDoEspiar`).
// Não troca o workspace aberto. Carregada sob demanda (junto com o motor).
import { useEffect, useRef, useState } from "react";
import { enterWorkspace } from "../../pages/cyno/WorkspaceCards";
import { depsDoCyno, montarCena, type CenaMontada } from "../montarCena";
import { ligarRetrato } from "../ligarRetrato";
import type { CenaStore } from "../cenaStore";
import { fontesDoEspiar } from "./fontesDoEspiar";

type Janela = { __espiar?: unknown };

export default function EspiarDialog({ workspaceId, nome, onFechar }: { workspaceId: string; nome: string; onFechar: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cena: CenaMontada = montarCena(canvas, "", depsDoCyno, (loja) => {
      const ligacao = ligarRetrato({ workspaceId, workspaceName: nome, fontes: fontesDoEspiar(workspaceId), destino: loja as CenaStore, aoPublicar: () => setCarregando(false) });
      return () => ligacao.desligar();
    }, { bichos: workspaceId });
    if (import.meta.env.DEV) (window as unknown as Janela).__espiar = cena.mundo;
    return () => {
      if (import.meta.env.DEV) delete (window as unknown as Janela).__espiar;
      cena.desmontar();
    };
  }, [workspaceId, nome]);

  const entrar = () => {
    onFechar();
    enterWorkspace(workspaceId);
  };

  return (
    <dialog ref={dialogRef} className="espiar" aria-labelledby="espiar-titulo" onCancel={(evento) => (evento.preventDefault(), onFechar())} onClose={onFechar} data-testid="espiar" data-workspace={workspaceId}>
      <header className="espiar__topo">
        <h3 id="espiar-titulo" className="espiar__titulo">
          {nome}
        </h3>
        <span className="espiar__aviso">só olhando: nada aqui muda o workspace</span>
        <div className="espiar__acoes">
          <button type="button" className="ui-button" onClick={entrar} data-testid="espiar-entrar">
            Entrar neste workspace
          </button>
          <button type="button" className="ui-button ui-button--ghost" onClick={onFechar} data-testid="espiar-fechar">
            Fechar
          </button>
        </div>
      </header>
      <div className="espiar__cena">
        <canvas ref={canvasRef} className="espiar__canvas" data-testid="espiar-canvas" aria-label={`Escritório de ${nome}, só para olhar`} role="img" />
        {carregando && <p className="espiar__carregando">Abrindo o escritório…</p>}
      </div>
    </dialog>
  );
}
