import { useNavStore } from "../store/navStore";
import { WorkspaceForm } from "./WorkspaceForm";
import "./noWorkspace.css";

/**
 * Estado vazio: não há workspace nenhum (todos excluídos, ou a instalação começou do zero). Explica
 * o que é um workspace e cria o primeiro ali mesmo; criado, a UI abre o escritório dele.
 */
export function NoWorkspace() {
  const go = useNavStore((state) => state.go);
  return (
    <main className="no-ws" data-testid="no-workspace">
      <div className="no-ws__inner">
        <header className="no-ws__header">
          <img className="no-ws__logo" src="/cyno-tile.svg" alt="" aria-hidden="true" width={44} height={44} />
          <p className="no-ws__eyebrow">Nenhum workspace</p>
          <h2 className="no-ws__title">Crie o seu primeiro workspace</h2>
          <p className="no-ws__lead">
            Um workspace é um escritório separado, com salas, agentes, tarefas e Cérebros próprios, coordenados por um Maestro. Use um para cada projeto ou cliente.
          </p>
        </header>
        <div className="no-ws__card">
          <WorkspaceForm variant="hero" onCreated={(created) => useNavStore.getState().setWorkspace(created.id)} />
        </div>
        <p className="no-ws__foot">
          Motores, modelos padrão e histórico continuam em{" "}
          <button type="button" className="no-ws__link" onClick={() => go("configuracoes")} data-testid="no-workspace-settings">
            Configurações
          </button>
          .
        </p>
      </div>
    </main>
  );
}
