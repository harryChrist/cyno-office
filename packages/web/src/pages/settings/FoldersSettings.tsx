import { WORK_FOLDER_LIMITS, type Workspace, type WorkFolder, type WorkFolderMode } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import "./foldersSettings.css";

const MODE_LABELS: Record<WorkFolderMode, string> = { read: "Só leitura", write: "Leitura e escrita" };

/** Escolha entre "Só leitura" e "Leitura e escrita" (dois botões lado a lado, um marcado). */
export function FolderModePicker({ value, onChange, disabled, label, testId }: { value: WorkFolderMode; onChange: (mode: WorkFolderMode) => void; disabled?: boolean; label: string; testId?: string }) {
  return (
    <div className="folder-mode" role="radiogroup" aria-label={label} data-testid={testId}>
      {(Object.keys(MODE_LABELS) as WorkFolderMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          className={`folder-mode__option${value === mode ? " folder-mode__option--on" : ""}${value === mode && mode === "write" ? " folder-mode__option--write" : ""}`}
          disabled={disabled}
          onClick={() => value !== mode && onChange(mode)}
          data-testid={testId ? `${testId}-${mode}` : undefined}
        >
          {MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

/**
 * Seção do workspace "Pastas de trabalho": pastas reais do computador (um projeto, um vault do Obsidian…) que os agentes
 * usam. Cada uma tem nome, caminho, "para que serve" (os agentes leem isso nas instruções) e o modo: só leitura ou leitura
 * e escrita. Cada agente só pode ter menos (painel dele). Trocar reinicia os terminais quando estiverem livres.
 */
export function FoldersSettings({ workspace, panel = false }: { workspace: Workspace; panel?: boolean }) {
  const folders = workspace.folders ?? [];
  const full = folders.length >= WORK_FOLDER_LIMITS.max;
  return (
    <div className={`settings__groups${panel ? " folders--panel" : ""}`} data-testid="settings-folders">
      <section className="settings__card">
        <header className="settings__card-head">
          {!panel && <h4 className="settings__card-title">Pastas que os agentes usam</h4>}
          <p className="settings__card-hint">
            Pastas do seu computador onde os agentes (o Maestro também) leem e trabalham. A pasta própria de cada agente continua sendo só rascunho. Tirar uma pasta daqui não apaga nada do disco. Trocar reinicia o terminal de cada agente quando ele estiver livre.
          </p>
        </header>
        {folders.length === 0 ? (
          <div className="folders__empty" data-testid="settings-folders-empty">
            <p className="folders__empty-title">Nenhuma pasta cadastrada</p>
            <p className="settings__card-hint">
              Cadastre a pasta de um projeto de código para os agentes lerem e editarem os arquivos reais, ou a de um vault do Obsidian para consultarem (ou anotarem em) suas notas. Em cada pasta você escreve para que ela serve e escolhe se os agentes só leem ou também escrevem.
            </p>
            <ul className="folders__examples">
              <li>
                <code>/home/voce/projetos/meu-app</code> <span>Código do app. Leitura e escrita para os desenvolvedores.</span>
              </li>
              <li>
                <code>/home/voce/Obsidian/Vault</code> <span>Minhas notas. Só leitura: consultar antes de responder.</span>
              </li>
            </ul>
          </div>
        ) : (
          <ul className="folders__list" aria-label="Pastas de trabalho" data-testid="settings-folders-list">
            {folders.map((folder) => (
              <FolderRow key={`${folder.id}:${folder.name}:${folder.purpose ?? ""}`} workspaceId={workspace.id} folder={folder} />
            ))}
          </ul>
        )}
        {folders.some((folder) => folder.mode === "write") && (
          <p className="settings__access-warn" role="note" data-testid="settings-folders-write-warn">
            Em pastas de leitura e escrita os agentes podem criar, alterar e apagar arquivos de verdade. Se for um projeto, vale ter o Git ou uma cópia antes.
          </p>
        )}
        {full ? <p className="settings__card-hint">O limite é de {WORK_FOLDER_LIMITS.max} pastas por workspace. Tire alguma para cadastrar outra.</p> : <AddFolderForm workspaceId={workspace.id} />}
      </section>
    </div>
  );
}

/** Uma pasta cadastrada: nome e "para que serve" editáveis (salvam ao sair do campo), modo e remover. */
function FolderRow({ workspaceId, folder }: { workspaceId: string; folder: WorkFolder }) {
  const { pending, error, run } = useAsyncAction();
  const [name, setName] = useState(folder.name);
  const [purpose, setPurpose] = useState(folder.purpose ?? "");
  const nameId = useId();
  const purposeId = useId();
  const save = (body: Parameters<typeof api.updateWorkFolder>[2]) => void run(() => api.updateWorkFolder(workspaceId, folder.id, body));
  return (
    <li className="folder-row" data-testid="settings-folder" data-folder-id={folder.id}>
      <div className="folder-row__top">
        <div className="folder-row__field folder-row__field--name">
          <label htmlFor={nameId} className="folder-row__label">
            Nome
          </label>
          <input
            id={nameId}
            className="ui-input"
            value={name}
            maxLength={WORK_FOLDER_LIMITS.name}
            onChange={(event) => setName(event.currentTarget.value)}
            onBlur={() => {
              const next = name.trim();
              if (!next) setName(folder.name);
              else if (next !== folder.name) save({ name: next });
            }}
            data-testid="settings-folder-name"
          />
        </div>
        <FolderModePicker value={folder.mode} label={`Modo da pasta ${folder.name}`} disabled={pending} onChange={(mode) => save({ mode })} testId="settings-folder-mode" />
        <button type="button" className="ui-button ui-button--secondary ui-button--small folder-row__remove" disabled={pending} onClick={() => void run(() => api.removeWorkFolder(workspaceId, folder.id))} aria-label={`Tirar a pasta ${folder.name} (não apaga nada do disco)`} title="Tira do workspace; não apaga nada do disco" data-testid="settings-folder-remove">
          Tirar
        </button>
      </div>
      <p className="folder-row__path" title={folder.path} data-testid="settings-folder-path">
        <code>{folder.path}</code>
      </p>
      <div className="folder-row__field">
        <label htmlFor={purposeId} className="folder-row__label">
          Para que serve
        </label>
        <input
          id={purposeId}
          className="ui-input"
          value={purpose}
          maxLength={WORK_FOLDER_LIMITS.purpose}
          placeholder="Ex.: código do app; minhas notas pessoais"
          onChange={(event) => setPurpose(event.currentTarget.value)}
          onBlur={() => purpose.trim() !== (folder.purpose ?? "") && save({ purpose: purpose.trim() })}
          data-testid="settings-folder-purpose"
        />
      </div>
      <ErrorText>{error}</ErrorText>
    </li>
  );
}

/** Formulário de cadastro: o caminho é digitado; o servidor confere e o erro aparece aqui, no lugar. */
function AddFolderForm({ workspaceId }: { workspaceId: string }) {
  const { pending, error, run, clearError } = useAsyncAction();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [purpose, setPurpose] = useState("");
  const [mode, setMode] = useState<WorkFolderMode>("read");
  const id = useId();
  const add = async () => {
    const result = await run(() => api.addWorkFolder(workspaceId, { name, path, ...(purpose.trim() ? { purpose } : {}), mode }));
    if (result) {
      setName("");
      setPath("");
      setPurpose("");
      setMode("read");
    }
  };
  return (
    <form
      className="folder-add"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      data-testid="settings-folder-add"
    >
      <h5 className="folder-add__title">Adicionar uma pasta</h5>
      <div className="folder-add__grid">
        <div className="folder-row__field">
          <label htmlFor={`${id}-name`} className="folder-row__label">
            Nome
          </label>
          <input id={`${id}-name`} className="ui-input" value={name} maxLength={WORK_FOLDER_LIMITS.name} placeholder="Ex.: Projeto do app" onChange={(event) => (clearError(), setName(event.currentTarget.value))} data-testid="settings-folder-add-name" />
        </div>
        <div className="folder-row__field">
          <label htmlFor={`${id}-path`} className="folder-row__label">
            Caminho completo
          </label>
          <input id={`${id}-path`} className="ui-input folder-add__path" value={path} maxLength={WORK_FOLDER_LIMITS.path} placeholder="/home/voce/projetos/meu-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => (clearError(), setPath(event.currentTarget.value))} data-testid="settings-folder-add-path" />
        </div>
      </div>
      <div className="folder-row__field">
        <label htmlFor={`${id}-purpose`} className="folder-row__label">
          Para que serve
        </label>
        <input id={`${id}-purpose`} className="ui-input" value={purpose} maxLength={WORK_FOLDER_LIMITS.purpose} placeholder="Ex.: código do app; minhas notas pessoais, consultar antes de responder" onChange={(event) => setPurpose(event.currentTarget.value)} data-testid="settings-folder-add-purpose" />
      </div>
      <div className="folder-add__actions">
        <FolderModePicker value={mode} label="Modo da nova pasta" onChange={setMode} testId="settings-folder-add-mode" />
        <button type="submit" className="ui-button ui-button--small" disabled={pending || !name.trim() || !path.trim()} aria-busy={pending} data-testid="settings-folder-add-submit">
          {pending ? "Conferindo…" : "Adicionar pasta"}
        </button>
      </div>
      <ErrorText testId="settings-folder-add-error">{error}</ErrorText>
    </form>
  );
}
