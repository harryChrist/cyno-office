import { BOARD_LIMITS, type Board } from "@cyno/shared";
import { useEffect, useState, type FormEvent } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Field, Modal } from "../../ui/widgets";

/** Ícones de traço (24x24) das ações do cabeçalho do quadro. */
const ICONS = {
  refresh: ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"],
  edit: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  trash: ["M3 6h18", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  back: ["m15 18-6-6 6-6"],
  chevron: ["m6 9 6 6 6-6"],
  search: ["M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z", "m21 21-4.3-4.3"],
  info: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 16v-4", "M12 8h.01"],
} as const;

export function QIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Relógio que faz o "há X min" andar sozinho. */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Renomear: título e descrição do quadro (a página e os dados não mudam). */
export function RenameDialog({ board, onSubmit, onClose }: { board: Board; onSubmit: (body: { title: string; description: string }) => Promise<unknown>; onClose: () => void }) {
  const [title, setTitle] = useState(board.title);
  const [description, setDescription] = useState(board.description);
  const { pending, error, run } = useAsyncAction();
  const valid = title.trim().length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const done = await run(async () => {
      await onSubmit({ title: title.trim(), description: description.trim() });
      return true;
    });
    if (done) onClose();
  };
  return (
    <Modal title="Renomear o quadro" onClose={onClose} testId="quadro-rename-dialog">
      <form className="quadro-form" onSubmit={(event) => void submit(event)}>
        <Field label="Título">
          {(props) => <input {...props} className="ui-input" value={title} maxLength={BOARD_LIMITS.title} onChange={(event) => setTitle(event.target.value)} autoFocus onFocus={(event) => event.currentTarget.select()} data-testid="quadro-rename-title" />}
        </Field>
        <Field label="Descrição" hint="Uma linha sobre o que o quadro mostra.">
          {(props) => <textarea {...props} className="ui-input" rows={3} value={description} maxLength={BOARD_LIMITS.description} onChange={(event) => setDescription(event.target.value)} data-testid="quadro-rename-description" />}
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={!valid || pending} data-testid="quadro-rename-confirm">
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
