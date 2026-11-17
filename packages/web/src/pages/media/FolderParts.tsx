import { useState, type DragEvent, type FormEvent } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Field, Modal } from "../../ui/widgets";
import { countLabel, crumbs, DRAG_TYPE, folderChoices, folderName, ROOT_LABEL, type FolderStat } from "./mediaFolders";
import { formatBytes } from "./mediaView";
import { MIcon } from "./MediaParts";

/** Peças das pastas da Mídia: migalhas, bloco de pasta, diálogos de nome e de mover, barra de seleção. */

/** Quem recebe o que foi arrastado (cartões) sobre uma pasta ou uma migalha. */
export function useFolderDrop(onDropIds: (ids: string[]) => void) {
  const [over, setOver] = useState(false);
  const carries = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(DRAG_TYPE);
  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!carries(event)) return;
        event.preventDefault();
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!carries(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave: (event: DragEvent) => {
        if (!carries(event) || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!carries(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        try {
          const ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as unknown;
          if (Array.isArray(ids)) onDropIds(ids.filter((id): id is string => typeof id === "string"));
        } catch {
          // Arraste de outra origem: ignora.
        }
      },
    },
  };
}

/** Rótulo de tamanho ("1,2 GB"): um lugar fixo no cabeçalho e em cada pasta (outra parte do app pode preenchê-lo com o uso real em disco). */
export function SizeLabel({ bytes, testId, className = "", title = "Tamanho dos arquivos" }: { bytes: number | undefined; testId?: string; className?: string; title?: string }) {
  if (bytes === undefined) return null;
  return (
    <span className={`md-size ${className}`.trim()} data-testid={testId} title={title}>
      {formatBytes(bytes)}
    </span>
  );
}

function CrumbButton({ path, label, current, onOpen, onDropIds }: { path: string; label: string; current: boolean; onOpen: (path: string) => void; onDropIds: (path: string, ids: string[]) => void }) {
  const drop = useFolderDrop((ids) => onDropIds(path, ids));
  return (
    <button type="button" className={`md-crumb${current ? " md-crumb--current" : ""}${drop.over ? " md-crumb--over" : ""}`} aria-current={current ? "page" : undefined} onClick={() => onOpen(path)} data-testid={`media-crumb-${path || "raiz"}`} {...drop.handlers}>
      {path === "" && <MIcon name="folder" size={14} />}
      <span className="md-crumb__label">{label}</span>
    </button>
  );
}

/** "Biblioteca / Livros / Matemática": cada parte abre a pasta (e recebe itens arrastados). */
export function Breadcrumb({ folder, onOpen, onDropIds }: { folder: string; onOpen: (path: string) => void; onDropIds: (path: string, ids: string[]) => void }) {
  const parts = crumbs(folder);
  return (
    <nav className="md-crumbs" aria-label="Pastas" data-testid="media-crumbs">
      <CrumbButton path="" label={ROOT_LABEL} current={folder === ""} onOpen={onOpen} onDropIds={onDropIds} />
      {parts.map((part, index) => (
        <span key={part.path} className="md-crumbs__step">
          <span className="md-crumbs__sep" aria-hidden="true">
            /
          </span>
          <CrumbButton path={part.path} label={part.name} current={index === parts.length - 1} onOpen={onOpen} onDropIds={onDropIds} />
        </span>
      ))}
    </nav>
  );
}

type BlockProps = {
  path: string;
  stat: FolderStat;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDropIds: (ids: string[]) => void;
};

/** Um bloco de pasta: abre ao clicar, recebe itens arrastados e tem renomear e apagar. */
export function FolderBlock({ path, stat, onOpen, onRename, onDelete, onDropIds }: BlockProps) {
  const drop = useFolderDrop(onDropIds);
  const name = folderName(path);
  return (
    <li className={`md-folder${drop.over ? " md-folder--over" : ""}`} data-testid={`media-folder-${path}`} {...drop.handlers}>
      <button type="button" className="md-folder__open" onClick={onOpen} aria-label={`Abrir a pasta ${name}`} data-testid={`media-folder-open-${path}`}>
        <span className="md-folder__icon" aria-hidden="true">
          <MIcon name="folder" size={22} />
        </span>
        <span className="md-folder__body">
          <span className="md-folder__name" title={name}>
            {name}
          </span>
          <span className="md-folder__meta">
            <span>{countLabel(stat.count)}</span>
            {stat.folders > 0 && <span>{stat.folders === 1 ? "1 subpasta" : `${stat.folders} subpastas`}</span>}
            <SizeLabel bytes={stat.bytes} testId={`media-folder-size-${path}`} />
          </span>
        </span>
      </button>
      <span className="md-folder__actions">
        <button type="button" className="ui-icon-button" onClick={onRename} aria-label={`Renomear a pasta ${name}`} title="Renomear" data-testid={`media-folder-rename-${path}`}>
          <MIcon name="edit" size={14} />
        </button>
        <button type="button" className="ui-icon-button" onClick={onDelete} aria-label={`Apagar a pasta ${name}`} title="Apagar a pasta" data-testid={`media-folder-delete-${path}`}>
          <MIcon name="trash" size={14} />
        </button>
      </span>
    </li>
  );
}

/** Nome de pasta: criar (vazio) ou renomear (com o nome atual). Fecha sozinho quando o servidor aceita. */
export function FolderNameDialog({ title, initial = "", confirmLabel, hint, onSubmit, onClose }: { title: string; initial?: string; confirmLabel: string; hint?: string; onSubmit: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const { pending, error, run } = useAsyncAction();
  const valid = name.trim().length > 0 && name.trim() !== "." && name.trim() !== "..";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const done = await run(async () => {
      await onSubmit(name.trim());
      return true;
    });
    if (done) onClose();
  };
  return (
    <Modal title={title} onClose={onClose} testId="media-folder-dialog">
      <form className="md-folderform" onSubmit={(event) => void submit(event)}>
        <Field label="Nome da pasta" {...(hint ? { hint } : {})}>
          {(props) => <input {...props} className="ui-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus onFocus={(event) => event.currentTarget.select()} data-testid="media-folder-name" />}
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={!valid || pending} data-testid="media-folder-confirm">
            {pending ? "Salvando…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "Mover para": a árvore de pastas (com a raiz); a pasta onde os itens já estão fica desligada. */
export function MoveDialog({ folders, count, from, onMove, onClose }: { folders: readonly string[]; count: number; from: string | null; onMove: (folder: string) => Promise<unknown>; onClose: () => void }) {
  const { pending, error, run } = useAsyncAction();
  const [target, setTarget] = useState<string | null>(null);
  const choices = folderChoices(folders);
  const move = async () => {
    if (target === null) return;
    const done = await run(async () => {
      await onMove(target);
      return true;
    });
    if (done) onClose();
  };
  const row = (path: string, label: string, depth: number) => (
    <li key={path || "raiz"}>
      <button type="button" className={`md-moveopt${target === path ? " md-moveopt--on" : ""}`} style={{ paddingLeft: 12 + depth * 18 }} disabled={from === path} aria-pressed={target === path} onClick={() => setTarget(path)} data-testid={`media-move-option-${path || "raiz"}`}>
        <MIcon name="folder" size={15} />
        <span className="md-moveopt__label">{label}</span>
        {from === path && <span className="md-moveopt__here">já está aqui</span>}
      </button>
    </li>
  );
  return (
    <Modal title={count === 1 ? "Mover 1 item para" : `Mover ${count} itens para`} onClose={onClose} testId="media-move-dialog">
      <ul className="md-movelist" aria-label="Pastas">
        {row("", ROOT_LABEL, 0)}
        {choices.map((choice) => row(choice.path, choice.name, choice.depth + 1))}
      </ul>
      <ErrorText>{error}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="ui-button" disabled={target === null || pending} onClick={() => void move()} data-testid="media-move-confirm">
          {pending ? "Movendo…" : "Mover"}
        </button>
      </div>
    </Modal>
  );
}

/** Barra de ações com itens selecionados: quantos, selecionar tudo, mover e sair. */
export function SelectionBar({ count, total, onAll, onMove, onCancel }: { count: number; total: number; onAll: () => void; onMove: () => void; onCancel: () => void }) {
  return (
    <div className="md-selbar" role="region" aria-label="Itens selecionados" data-testid="media-selbar">
      <span className="md-selbar__count" aria-live="polite">
        {count === 0 ? "Nenhum selecionado" : count === 1 ? "1 selecionado" : `${count} selecionados`}
      </span>
      {count < total && (
        <button type="button" className="ui-button ui-button--secondary" onClick={onAll} data-testid="media-select-all">
          Selecionar tudo
        </button>
      )}
      <button type="button" className="ui-button" disabled={count === 0} onClick={onMove} data-testid="media-move">
        <MIcon name="arrow" size={14} />
        Mover para…
      </button>
      <button type="button" className="ui-button ui-button--secondary" onClick={onCancel} data-testid="media-select-cancel">
        Cancelar
      </button>
    </div>
  );
}
