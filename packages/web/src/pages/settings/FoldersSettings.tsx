import { WORK_FOLDER_LIMITS, type StorageFolder, type Workspace, type WorkFolder, type WorkFolderMode } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { isDesktopApp, pickFolder } from "../../desktop/desktopBridge";
import { FolderPicker } from "../../ui/FolderPicker";
import { resolveFolderPick, suggestedFolderName } from "../../ui/folderPickerLogic";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { StorageCard } from "./StorageCard";
import { CloneRepoDialog } from "./CloneRepoDialog";
import { GitCredentialsPanel } from "./GitCredentialsPanel";
import { storageLabel, storageTitle } from "./storageView";
import { useStorage } from "./useStorage";
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
 * usam. Cada uma é uma linha compacta com nome, caminho, "para que serve" (os agentes leem isso nas instruções) e o modo: só
 * leitura ou leitura e escrita. Cada agente só pode ter menos (painel dele). Trocar reinicia os terminais quando estiverem livres.
 */
export function FoldersSettings({ workspace, panel = false }: { workspace: Workspace; panel?: boolean }) {
  const folders = workspace.folders ?? [];
  // Uma única consulta de espaço em disco serve as linhas e o cartão (no painel da barra só as linhas).
  const storage = useStorage(workspace.id, folders.map((folder) => folder.id).join(","));
  const full = folders.length >= WORK_FOLDER_LIMITS.max;
  const [adding, setAdding] = useState(false);
  const [cloning, setCloning] = useState(false);
  const addButton = (
    <div className="folders__git-actions">
      <button type="button" className="ui-button ui-button--ghost ui-button--small folders__add-btn" onClick={() => setCloning(true)} data-testid="settings-folder-clone-open">
        Clonar repositório…
      </button>
      <button type="button" className="ui-button ui-button--small folders__add-btn" aria-expanded={adding} aria-controls="folders-add-form" onClick={() => setAdding((open) => !open)} data-testid="settings-folder-add-toggle">
        <span aria-hidden="true">{adding ? "−" : "+"}</span> {adding ? "Fechar" : "Adicionar pasta"}
      </button>
    </div>
  );
  return (
    <div className={`settings__groups${panel ? " folders--panel" : ""}`} data-testid="settings-folders">
      <section className="settings__card folders">
        <header className="folders__head">
          <div className="folders__head-text">
            {!panel && <h4 className="settings__card-title">Pastas que os agentes usam</h4>}
            <p className="settings__card-hint">Pastas do seu computador onde os agentes e o Maestro leem e trabalham. Tirar uma daqui não apaga nada.</p>
            <details className="folders__more settings__more">
              <summary>Saiba mais</summary>
              <p className="settings__card-hint">A pasta própria de cada agente continua sendo só rascunho. Trocar uma pasta reinicia o terminal de cada agente quando ele estiver livre.</p>
            </details>
          </div>
          {!full && folders.length > 0 && addButton}
        </header>
        {folders.length === 0 ? (
          <div className="folders__empty" data-testid="settings-folders-empty">
            <p className="folders__empty-title">Nenhuma pasta cadastrada</p>
            <p className="folders__empty-hint">Cadastre a pasta de um projeto ou de notas para os agentes lerem ou editarem.</p>
            {!adding && addButton}
          </div>
        ) : (
          <ul className="folders__list" aria-label="Pastas de trabalho" data-testid="settings-folders-list">
            {folders.map((folder) => (
              <FolderRow key={`${folder.id}:${folder.name}:${folder.purpose ?? ""}`} workspaceId={workspace.id} folder={folder} size={storage.data?.folders.find((item) => item.id === folder.id)} onRefreshSize={storage.refresh} />
            ))}
          </ul>
        )}
        {folders.some((folder) => folder.mode === "write") && (
          <p className="settings__access-warn" role="note" data-testid="settings-folders-write-warn">
            Com leitura e escrita, os agentes podem criar, alterar e apagar arquivos de verdade. Tenha o Git ou uma cópia antes.
          </p>
        )}
        {full && <p className="settings__card-hint">O limite é de {WORK_FOLDER_LIMITS.max} pastas por workspace. Tire alguma para cadastrar outra.</p>}
        {!full && adding && <AddFolderForm id="folders-add-form" workspaceId={workspace.id} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />}
        {!full && cloning && <CloneRepoDialog workspaceId={workspace.id} onClose={() => setCloning(false)} />}
      </section>
      {!panel && <GitCredentialsPanel />}
      {!panel && <StorageCard workspace={workspace} data={storage.data} failed={storage.failed} onRefresh={storage.refresh} />}
    </div>
  );
}

/**
 * Uma pasta cadastrada, em linhas curtas: nome e "para que serve" editam no lugar (salvam ao sair do campo), o caminho
 * aparece truncado (inteiro no title), o modo é um controle pequeno e "Tirar" é discreto. À direita fica o tamanho em disco
 * (`settings-folder-size`): "calculando…" enquanto o servidor mede, "sem acesso" se a pasta não abre; o title tem arquivos e hora.
 */
function FolderRow({ workspaceId, folder, size, onRefreshSize }: { workspaceId: string; folder: WorkFolder; size: StorageFolder | undefined; onRefreshSize: () => void }) {
  const { pending, error, run } = useAsyncAction();
  const [name, setName] = useState(folder.name);
  const [purpose, setPurpose] = useState(folder.purpose ?? "");
  const nameId = useId();
  const purposeId = useId();
  const save = (body: Parameters<typeof api.updateWorkFolder>[2]) => void run(() => api.updateWorkFolder(workspaceId, folder.id, body));
  return (
    <li className="folder-row" data-testid="settings-folder" data-folder-id={folder.id}>
      <div className="folder-row__head">
        <label htmlFor={nameId} className="sr-only">
          Nome da pasta
        </label>
        <input
          id={nameId}
          className="folder-row__name"
          value={name}
          maxLength={WORK_FOLDER_LIMITS.name}
          title="Clique para renomear"
          onChange={(event) => setName(event.currentTarget.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next) setName(folder.name);
            else if (next !== folder.name) save({ name: next });
          }}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          data-testid="settings-folder-name"
        />
        <FolderModePicker value={folder.mode} label={`Modo da pasta ${folder.name}`} disabled={pending} onChange={(mode) => save({ mode })} testId="settings-folder-mode" />
        <span className="folder-row__size" aria-live="polite" data-state={size?.state} title={size ? storageTitle(size) : undefined} data-testid="settings-folder-size">
          {size ? storageLabel(size) : ""}
        </span>
        <button type="button" className="folder-row__refresh" disabled={size?.state === "computing"} onClick={onRefreshSize} aria-label={`Recalcular o tamanho da pasta ${folder.name}`} title="Recalcular o tamanho" data-testid="settings-folder-size-refresh">
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M16 10a6 6 0 1 1-1.9-4.4M16 3.5v3.3h-3.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="folder-row__remove" disabled={pending} onClick={() => void run(() => api.removeWorkFolder(workspaceId, folder.id))} aria-label={`Tirar a pasta ${folder.name} (não apaga nada do disco)`} title="Tirar do workspace (não apaga nada do disco)" data-testid="settings-folder-remove">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="folder-row__meta">
        <p className="folder-row__path" title={folder.path} data-testid="settings-folder-path">
          <code>{folder.path}</code>
        </p>
        <label htmlFor={purposeId} className="sr-only">
          Para que serve
        </label>
        <input
          id={purposeId}
          className="folder-row__purpose"
          value={purpose}
          maxLength={WORK_FOLDER_LIMITS.purpose}
          placeholder="Para que serve? (os agentes leem isto)"
          onChange={(event) => setPurpose(event.currentTarget.value)}
          onBlur={() => purpose.trim() !== (folder.purpose ?? "") && save({ purpose: purpose.trim() })}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          data-testid="settings-folder-purpose"
        />
      </div>
      <ErrorText>{error}</ErrorText>
    </li>
  );
}

/** Formulário de cadastro (recolhido atrás de "Adicionar pasta"): permite escolher no disco ou digitar o caminho; o servidor confere e o erro aparece aqui. */
function AddFolderForm({ id, workspaceId, onDone, onCancel }: { id: string; workspaceId: string; onDone: () => void; onCancel: () => void }) {
  const { pending, error, run, clearError } = useAsyncAction();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [purpose, setPurpose] = useState("");
  const [mode, setMode] = useState<WorkFolderMode>("read");
  const [pickerOpen, setPickerOpen] = useState(false);
  const applyPickedFolder = (pickedPath: string) => {
    clearError();
    setPath(pickedPath);
    setName((current) => (current.trim() ? current : suggestedFolderName(pickedPath)));
    setPickerOpen(false);
  };
  const chooseFolder = async () => {
    const decision = await resolveFolderPick({ desktop: isDesktopApp(), pickNative: pickFolder });
    if (decision.kind === "picked") applyPickedFolder(decision.path);
    else if (decision.kind === "open-modal") setPickerOpen(true);
  };
  const add = async () => {
    const result = await run(() => api.addWorkFolder(workspaceId, { name, path, ...(purpose.trim() ? { purpose } : {}), mode }));
    if (result) onDone();
  };
  return (
    <>
      <form
        id={id}
        className="folder-add"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
        data-testid="settings-folder-add"
      >
        <div className="folder-add__grid">
          <div className="folder-row__field">
            <label htmlFor={`${id}-name`} className="folder-row__label">
              Nome
            </label>
            <input id={`${id}-name`} className="ui-input" value={name} maxLength={WORK_FOLDER_LIMITS.name} placeholder="Ex.: Projeto do app" autoFocus onChange={(event) => (clearError(), setName(event.currentTarget.value))} data-testid="settings-folder-add-name" />
          </div>
          <div className="folder-row__field">
            <label htmlFor={`${id}-path`} className="folder-row__label">
              Caminho completo
            </label>
            <div className="folder-add__path-row">
              <input id={`${id}-path`} className="ui-input folder-add__path" value={path} maxLength={WORK_FOLDER_LIMITS.path} placeholder="/home/voce/projetos/meu-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => (clearError(), setPath(event.currentTarget.value))} data-testid="settings-folder-add-path" />
              <button type="button" className="ui-button ui-button--secondary ui-button--small folder-add__browse" disabled={pending} onClick={() => void chooseFolder()} data-testid="settings-folder-browse">
                Escolher pasta…
              </button>
            </div>
          </div>
        </div>
        <div className="folder-row__field">
          <label htmlFor={`${id}-purpose`} className="folder-row__label">
            Para que serve (opcional)
          </label>
          <input id={`${id}-purpose`} className="ui-input" value={purpose} maxLength={WORK_FOLDER_LIMITS.purpose} placeholder="Ex.: código do app; minhas notas, consultar antes de responder" onChange={(event) => setPurpose(event.currentTarget.value)} data-testid="settings-folder-add-purpose" />
        </div>
        <div className="folder-add__actions">
          <FolderModePicker value={mode} label="Modo da nova pasta" onChange={setMode} testId="settings-folder-add-mode" />
          <div className="folder-add__buttons">
            <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onCancel} data-testid="settings-folder-add-cancel">
              Cancelar
            </button>
            <button type="submit" className="ui-button ui-button--small" disabled={pending || !name.trim() || !path.trim()} aria-busy={pending} data-testid="settings-folder-add-submit">
              {pending ? "Conferindo…" : "Adicionar pasta"}
            </button>
          </div>
        </div>
        <ErrorText testId="settings-folder-add-error">{error}</ErrorText>
      </form>
      {pickerOpen && <FolderPicker initialPath={path.trim() || undefined} onSelect={applyPickedFolder} onClose={() => setPickerOpen(false)} />}
    </>
  );
}
