import { ACCESS_LABELS, effectiveAccess, effectiveFolders, folderEngineNote, workspaceAccess, type Agent, type AgentFolderAccess, type AgentFolders, type AgentEngine, type EffectiveAccess, type WorkFolder, type WorkspaceAccess } from "@cyno/shared";
import { useNavStore } from "../store/navStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { Switch } from "./widgets";
import "../pages/settings/foldersSettings.css";

/** A política de acesso do workspace aberto (com os padrões; workspace antigo = os padrões). */
export function useWorkspaceAccess(): WorkspaceAccess {
  const id = useNavStore((state) => state.workspaceId);
  const raw = useWorkspaceStore((state) => state.workspaces?.find((ws) => ws.id === id)?.access);
  return workspaceAccess(raw);
}

/** Acesso efetivo do agente no workspace aberto. */
export function useAgentAccess(agent: Pick<Agent, "internet" | "browser" | "terminal">): EffectiveAccess {
  return effectiveAccess(useWorkspaceAccess(), agent);
}

/** "Internet · Navegador" (o que está ligado) ou "Só o escritório". */
export function accessLabel(access: EffectiveAccess): string {
  const on = (Object.keys(ACCESS_LABELS) as (keyof EffectiveAccess)[]).filter((key) => access[key]).map((key) => ACCESS_LABELS[key].short);
  return on.length > 0 ? on.join(" · ") : "Só o escritório";
}

/** Selo discreto da lista de agentes: globo (internet), janela (navegador) e ">_" (terminal), só o que está ligado. */
export function AccessBadges({ access }: { access: EffectiveAccess }) {
  if (!access.internet && !access.terminal) return null;
  return (
    <span className="access-badges" title={`Acesso: ${accessLabel(access)}`} data-testid="agent-access-badges">
      {access.internet && (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-access="internet">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.8 8h12.4M8 1.8c2 2.2 2 10.2 0 12.4M8 1.8c-2 2.2-2 10.2 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
      {access.browser && (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-access="browser">
          <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.8 5.8h12.4" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
      {access.terminal && (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" data-access="terminal" className="access-badges__terminal">
          <path d="M2.5 4.5 6 8l-3.5 3.5M7.5 12h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="sr-only">Acesso: {accessLabel(access)}</span>
    </span>
  );
}

type AccessValues = { internet: boolean; browser: boolean; terminal: boolean };

/**
 * Interruptores do acesso de um agente: só restringem o que o workspace permite. Desligado no
 * workspace = interruptor desligado e travado, com a dica de onde mudar.
 */
export function AgentAccessFields({ values, onChange, testIdPrefix = "agent-edit" }: { values: AccessValues; onChange: (values: AccessValues) => void; testIdPrefix?: string }) {
  const ws = useWorkspaceAccess();
  const offInWorkspace = "Desligado em Configurações › Acesso dos agentes.";
  const restart = "Trocar reinicia o terminal do agente quando ele estiver livre.";
  return (
    <fieldset className="agent-access" data-testid={`${testIdPrefix}-access`}>
      <legend className="agent-access__legend">Acesso</legend>
      <Switch
        label="Internet (pesquisa e páginas)"
        description={ws.internet ? restart : offInWorkspace}
        checked={ws.internet && values.internet}
        disabled={!ws.internet}
        onChange={(internet) => onChange({ ...values, internet })}
        testId={`${testIdPrefix}-internet`}
      />
      <Switch
        label="Navegador compartilhado"
        description={!ws.internet || !ws.browser ? offInWorkspace : values.internet ? "Precisa da internet." : "Ligue a internet do agente para usar o navegador."}
        checked={ws.internet && ws.browser && values.internet && values.browser}
        disabled={!ws.internet || !ws.browser || !values.internet}
        onChange={(browser) => onChange({ ...values, browser })}
        testId={`${testIdPrefix}-browser`}
      />
      <Switch
        label="Terminal no servidor"
        description={ws.terminal ? "Roda comandos na sua máquina, dentro da pasta do agente." : offInWorkspace}
        checked={ws.terminal && values.terminal}
        disabled={!ws.terminal}
        onChange={(terminal) => onChange({ ...values, terminal })}
        testId={`${testIdPrefix}-terminal`}
      />
    </fieldset>
  );
}

const NO_FOLDERS: WorkFolder[] = [];

/** As pastas de trabalho do workspace aberto (lista vazia = nenhuma; workspace antigo, sem o campo, também). */
export function useWorkspaceFolders(): WorkFolder[] {
  const id = useNavStore((state) => state.workspaceId);
  return useWorkspaceStore((state) => state.workspaces?.find((ws) => ws.id === id)?.folders) ?? NO_FOLDERS;
}

type FolderChoice = "" | AgentFolderAccess;

/**
 * Ajuste por pasta de trabalho de um agente: para cada pasta do workspace, "Como no workspace" (padrão), "Só leitura" (só
 * faz diferença onde o workspace dá escrita) ou "Sem acesso". Só reduz, nunca dá mais que o workspace. Sem pastas no
 * workspace: uma linha apontando para as Configurações. `engine` e `terminal` (o efetivo do agente) escolhem o aviso de
 * onde "só leitura" não é trava.
 */
export function AgentFolderFields({ values, onChange, engine, terminal, testIdPrefix = "agent-edit" }: { values: AgentFolders; onChange: (values: AgentFolders) => void; engine: AgentEngine; terminal: boolean; testIdPrefix?: string }) {
  const folders = useWorkspaceFolders();
  const ws = useWorkspaceAccess();
  const readOnlySomewhere = effectiveFolders(folders, { folders: values }).some((folder) => !folder.write);
  const note = readOnlySomewhere ? folderEngineNote(engine, terminal && ws.terminal) : null;
  const choose = (folder: WorkFolder, choice: FolderChoice) => {
    const next: AgentFolders = { ...values };
    if (choice === "") delete next[folder.id];
    else next[folder.id] = choice;
    onChange(next);
  };
  return (
    <fieldset className="agent-folders" data-testid={`${testIdPrefix}-folders`}>
      <legend className="agent-folders__legend">Pastas de trabalho</legend>
      {folders.length === 0 ? (
        <p className="ui-muted" data-testid={`${testIdPrefix}-folders-empty`}>
          O workspace ainda não tem pastas de trabalho. Cadastre em Configurações, Pastas de trabalho.
        </p>
      ) : (
        <>
          {folders.map((folder) => {
            const current: FolderChoice = values[folder.id] ?? "";
            const label = `Pasta ${folder.name}`;
            return (
              <div className="agent-folder" key={folder.id} data-testid={`${testIdPrefix}-folder`}>
                <div className="agent-folder__info">
                  <span className="agent-folder__name">{folder.name}</span>
                  <span className="agent-folder__meta" title={folder.path}>
                    {folder.mode === "write" ? "Leitura e escrita no workspace" : "Só leitura no workspace"} · {folder.path}
                  </span>
                </div>
                <select className="ui-input ui-input--compact" aria-label={label} value={current} onChange={(event) => choose(folder, event.currentTarget.value as FolderChoice)} data-testid={`${testIdPrefix}-folder-choice`}>
                  <option value="">Como no workspace</option>
                  {(folder.mode === "write" || current === "read") && <option value="read">Só leitura</option>}
                  <option value="off">Sem acesso</option>
                </select>
              </div>
            );
          })}
          <p className="ui-muted">Só reduz o que o workspace dá. Trocar reinicia o terminal do agente quando ele estiver livre.</p>
          {note && (
            <p className="agent-folders__note" role="note" data-testid={`${testIdPrefix}-folders-note`}>
              {note}
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
