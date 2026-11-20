import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { draftOf, setDraft, useFilesStore, type EditSession } from "../../store/filesStore";

/**
 * O editor de texto: um <textarea> sem controle do React. O texto digitado fica num rascunho fora do estado global
 * (`setDraft`) e só a marca "sujo" vai para a store, quando muda de valor: um arquivo de 512 KB não pode ser recriado
 * no estado a cada tecla. Tab põe dois espaços; Ctrl+S e Cmd+S salvam.
 */
export function FileEditor({ editKey, session, wrap, onSave }: { editKey: string; session: EditSession; wrap: boolean; onSave: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = useRef(session.dirty);
  // A marca "sujo" que a store tem (ao recarregar, ela volta a falso).
  useEffect(() => {
    dirty.current = session.dirty;
  }, [session.dirty]);

  useEffect(() => {
    area.current?.focus();
  }, []);

  const sync = (value: string) => {
    setDraft(editKey, value);
    const now = value !== session.text;
    if (now !== dirty.current) {
      dirty.current = now;
      useFilesStore.getState().setDirty(editKey, now);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const node = event.currentTarget;
      node.setRangeText("  ", node.selectionStart, node.selectionEnd, "end");
      sync(node.value);
    }
  };

  return (
    <textarea
      ref={area}
      key={session.rev}
      className={`files-editor${wrap ? " files-editor--wrap" : ""}`}
      defaultValue={draftOf(editKey) ?? session.text}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap={wrap ? "soft" : "off"}
      aria-label="Texto do arquivo"
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => sync(event.target.value)}
      onKeyDown={onKeyDown}
      data-testid="files-editor"
    />
  );
}
