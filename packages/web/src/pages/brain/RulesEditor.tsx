import { BRAIN_RULE_LIMITS } from "@cyno/shared";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { describeError } from "../../api/client";
import { ErrorText } from "../../ui/widgets";
import { cleanRule, parseRules, renderRules, rulesCountLabel } from "./rulesText";

type Row = { id: number; text: string };

let rowSequence = 0;
/** Uma linha nova da lista (o id só serve de chave e de alvo do foco). */
const row = (text: string): Row => ({ id: ++rowSequence, text });

/** Campo de uma regra: cresce com o texto (sem barra de rolagem) e nunca quebra em parágrafos. */
function RuleField({
  value,
  focus,
  disabled,
  label,
  placeholder,
  onChange,
  onKeyDown,
  testId,
}: {
  value: string;
  focus: boolean;
  disabled: boolean;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  testId: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    if (!focus) return;
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [focus]);
  return (
    <textarea
      ref={ref}
      className="brain-rules__field"
      rows={1}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value.replace(/\n/g, " "))}
      onKeyDown={onKeyDown}
      data-testid={testId}
    />
  );
}

/**
 * Edição das regras (da sala ou de um agente). Uma regra por linha, cada uma no seu campo: Enter
 * cria a próxima, apagar um campo vazio volta para a de cima. "Editar como texto" abre o markdown
 * inteiro (é o único modo quando o texto tem mais do que uma lista simples). `onSave` devolve uma
 * promessa; o erro do server aparece embaixo e o que foi escrito fica como está.
 */
export function RulesEditor({
  initial,
  label,
  onSave,
  onCancel,
  testId,
}: {
  initial: string;
  label: string;
  onSave: (content: string) => Promise<unknown>;
  onCancel: () => void;
  testId: string;
}) {
  const parsed = parseRules(initial);
  const [mode, setMode] = useState<"lista" | "texto">(parsed ? "lista" : "texto");
  const [intro, setIntro] = useState(parsed?.intro ?? "");
  const [rows, setRows] = useState<Row[]>(() => {
    const rules = parsed?.rules ?? [];
    return rules.length > 0 ? rules.map(row) : [row("")];
  });
  const [text, setText] = useState(initial);
  // Ao abrir, o cursor vai para o fim da última regra (ou para a primeira linha, vazia).
  const [focusId, setFocusId] = useState<number | null>(() => rows[rows.length - 1]?.id ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const max = BRAIN_RULE_LIMITS.rulesFile;
  const content = mode === "lista" ? renderRules({ intro, rules: rows.map((item) => item.text) }) : text.trim();
  const over = content.length > max;

  const change = (id: number, value: string) => setRows((current) => current.map((item) => (item.id === id ? { ...item, text: value } : item)));
  const addAfter = (index: number) => {
    const added = row("");
    setRows((current) => [...current.slice(0, index + 1), added, ...current.slice(index + 1)]);
    setFocusId(added.id);
  };
  const remove = (index: number) => {
    setRows((current) => {
      const next = current.filter((_, position) => position !== index);
      if (next.length === 0) {
        const empty = row("");
        setFocusId(empty.id);
        return [empty];
      }
      setFocusId(next[Math.max(0, index - 1)]!.id);
      return next;
    });
  };
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (rows[index]!.text.trim()) addAfter(index);
      return;
    }
    if (event.key === "Backspace" && rows[index]!.text === "" && rows.length > 1) {
      event.preventDefault();
      remove(index);
    }
  };

  const toText = () => {
    setText(content);
    setNotice(null);
    setMode("texto");
  };
  const toList = () => {
    const draft = parseRules(text);
    if (!draft) {
      setNotice("Este texto tem mais do que uma lista de regras (títulos ou parágrafos no meio). Para editar em lista, deixe só uma regra por linha, cada uma começando com um traço.");
      return;
    }
    setIntro(draft.intro);
    setRows(draft.rules.length > 0 ? draft.rules.map(row) : [row("")]);
    setNotice(null);
    setMode("lista");
  };

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await onSave(content);
    } catch (caught) {
      setError(describeError(caught));
      setPending(false);
    }
  };

  return (
    <div className="brain-editor" data-testid={testId} data-mode={mode}>
      {mode === "lista" ? (
        <>
          {intro && <p className="brain-editor__intro">{intro}</p>}
          <ol className="brain-rules" aria-label={label}>
            {rows.map((item, index) => (
              <li key={item.id} className="brain-rules__row" data-testid={`${testId}-rule`}>
                <span className="brain-rules__number" aria-hidden="true">
                  {index + 1}
                </span>
                <RuleField
                  value={item.text}
                  focus={focusId === item.id}
                  disabled={pending}
                  label={`Regra ${index + 1}`}
                  placeholder={index === 0 ? "Ex.: Sempre conferir a contagem antes de publicar." : "Escreva a regra"}
                  onChange={(value) => change(item.id, value)}
                  onKeyDown={onKeyDown(index)}
                  testId={`${testId}-rule-field`}
                />
                <button
                  type="button"
                  className="brain-rules__remove"
                  onClick={() => remove(index)}
                  disabled={pending || (rows.length === 1 && cleanRule(item.text) === "")}
                  aria-label={`Remover a regra ${index + 1}`}
                  title="Remover"
                  data-testid={`${testId}-remove`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="brain-rules__add" onClick={() => addAfter(rows.length - 1)} disabled={pending} data-testid={`${testId}-add`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Adicionar regra
          </button>
        </>
      ) : (
        <textarea
          className="ui-input brain-editor__field"
          rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
          value={text}
          aria-label={label}
          spellCheck={false}
          autoFocus
          disabled={pending}
          onChange={(event) => setText(event.currentTarget.value)}
          data-testid={`${testId}-field`}
        />
      )}
      {notice && (
        <p className="brain-editor__notice" role="status">
          {notice}
        </p>
      )}
      <ErrorText testId={`${testId}-error`}>{error}</ErrorText>
      <div className="brain-editor__bar">
        <p className={`brain-editor__counter${over ? " brain-editor__counter--over" : ""}`} data-testid={`${testId}-counter`}>
          {mode === "lista" ? `${rulesCountLabel(rows.map((item) => item.text))} · ` : ""}
          {content.length.toLocaleString("pt-BR")} / {max.toLocaleString("pt-BR")}
        </p>
        <button type="button" className="brain-editor__mode" onClick={mode === "lista" ? toText : toList} disabled={pending} data-testid={`${testId}-mode`}>
          {mode === "lista" ? "Editar como texto" : "Editar em lista"}
        </button>
        <div className="brain-editor__actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onCancel} disabled={pending} data-testid={`${testId}-cancel`}>
            Cancelar
          </button>
          <button type="button" className="ui-button ui-button--small ui-button--success" onClick={() => void save()} disabled={pending || over} data-testid={`${testId}-save`}>
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}
