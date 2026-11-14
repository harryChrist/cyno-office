import {
  FOR_YOU_FALLBACK_TYPE,
  FOR_YOU_TYPE_BEHAVIOR_LABELS,
  FOR_YOU_TYPE_BEHAVIORS,
  FOR_YOU_TYPE_COLOR_LABELS,
  FOR_YOU_TYPE_COLORS,
  FOR_YOU_TYPE_CREATOR_LABELS,
  FOR_YOU_TYPE_ICONS,
  forYouTypeColorVar,
  isBuiltinForYouType,
  type ForYouItem,
  type ForYouTypeDef,
} from "@cyno/shared";
import { useId, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ConfirmDialog, ErrorText, Modal } from "../../ui/widgets";
import { typeStyle } from "./forYouView";
import { Icon } from "./icons";
import { createBody, formFromType, itemCounts, itemsLabel, limitsSummary, suggestedIcon, updateBody, type TypeForm, type TypeFormErrors } from "./typeForm";

type SheetProps = {
  items: readonly ForYouItem[];
  types: readonly ForYouTypeDef[];
  onClose: () => void;
  /** Aviso na página depois de salvar, juntar ou excluir. */
  onDone: (message: string) => void;
  /** O tipo saiu (excluído ou juntado): o filtro da página volta para "Todos" se era ele. */
  onRemoved: (id: string) => void;
};

type View = { kind: "list" } | { kind: "edit"; id: string | null };

/**
 * Janela "Tipos de aprovação" do "Para você": a lista dos tipos do workspace (ícone, cor,
 * descrição, comportamento, limites e quem criou) e, para cada um, editar, juntar com outro e
 * excluir (os itens vão para "Outro"). Também cria um tipo novo.
 */
export function ForYouTypesSheet({ items, types, onClose, onDone, onRemoved }: SheetProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [deleting, setDeleting] = useState<ForYouTypeDef | null>(null);
  const [merging, setMerging] = useState<ForYouTypeDef | null>(null);
  const counts = useMemo(() => itemCounts(items), [items]);
  const editing = view.kind === "edit" && view.id ? types.find((type) => type.id === view.id) ?? null : null;
  const title = view.kind === "list" ? "Tipos de aprovação" : editing ? `Editar “${editing.name}”` : "Novo tipo";

  return (
    <>
      <Modal title={title} onClose={onClose} wide testId="foryou-types-sheet">
        {view.kind === "list" ? (
          <TypeListView
            types={types}
            counts={counts}
            onNew={() => setView({ kind: "edit", id: null })}
            onEdit={(type) => setView({ kind: "edit", id: type.id })}
            onMerge={setMerging}
            onDelete={setDeleting}
          />
        ) : (
          <TypeFormView
            key={view.id ?? "novo"}
            type={editing}
            types={types}
            onCancel={() => setView({ kind: "list" })}
            onSaved={(saved, created) => {
              onDone(created ? `Tipo “${saved.name}” criado.` : `Tipo “${saved.name}” salvo.`);
              setView({ kind: "list" });
            }}
          />
        )}
      </Modal>
      {deleting && (
        <ConfirmDialog
          title={`Excluir o tipo “${deleting.name}”?`}
          message={<DeleteMessage type={deleting} count={counts.get(deleting.id) ?? 0} fallback={types.find((type) => type.id === FOR_YOU_FALLBACK_TYPE)?.name ?? "Outro"} />}
          confirmLabel="Excluir tipo"
          onConfirm={async () => {
            await api.deleteForYouType(deleting.id);
            onRemoved(deleting.id);
            onDone(`Tipo “${deleting.name}” excluído.`);
          }}
          onClose={() => setDeleting(null)}
          testId="foryou-type-delete"
        />
      )}
      {merging && (
        <MergeDialog
          type={merging}
          types={types}
          count={counts.get(merging.id) ?? 0}
          onClose={() => setMerging(null)}
          onMerged={(target) => {
            onRemoved(merging.id);
            onDone(`“${merging.name}” juntado com “${target.name}”.`);
          }}
        />
      )}
    </>
  );
}

function DeleteMessage({ type, count, fallback }: { type: ForYouTypeDef; count: number; fallback: string }) {
  return (
    <p data-testid="foryou-type-delete-message">
      {count > 0 ? (
        <>
          {count === 1 ? "O item" : `Os ${count} itens`} de <strong>{type.name}</strong> {count === 1 ? "vai" : "vão"} para <strong>{fallback}</strong>. Nada é apagado.
        </>
      ) : (
        <>
          Nenhum item usa <strong>{type.name}</strong>. Se um agente pedir este tipo de novo, ele volta a ser criado.
        </>
      )}
    </p>
  );
}

/** Ícone na cor do tipo, num quadradinho com fundo suave. */
function TypeBadge({ type, size = 18 }: { type: Pick<ForYouTypeDef, "icon" | "color">; size?: number }) {
  return (
    <span className="fy-tbadge" style={typeStyle(type)} aria-hidden="true">
      <Icon name={type.icon} size={size} />
    </span>
  );
}

type ListProps = {
  types: readonly ForYouTypeDef[];
  counts: Map<string, number>;
  onNew: () => void;
  onEdit: (type: ForYouTypeDef) => void;
  onMerge: (type: ForYouTypeDef) => void;
  onDelete: (type: ForYouTypeDef) => void;
};

function TypeListView({ types, counts, onNew, onEdit, onMerge, onDelete }: ListProps) {
  return (
    <div className="fy-tsheet">
      <div className="fy-tsheet__intro">
        <p>Cada workspace tem os seus tipos. O Maestro cria novos quando o projeto precisa; aqui você ajusta nome, descrição, ícone, cor e limites.</p>
        <button type="button" className="ui-button ui-button--small" onClick={onNew} data-testid="foryou-type-new">
          <Icon name="plus" size={14} />
          Novo tipo
        </button>
      </div>
      <ul className="fy-tlist" data-testid="foryou-type-list">
        {types.map((type) => {
          const builtin = isBuiltinForYouType(type.id);
          const count = counts.get(type.id) ?? 0;
          return (
            <li key={type.id} className="fy-trow" data-testid={`foryou-type-row-${type.id}`}>
              <TypeBadge type={type} />
              <div className="fy-trow__body">
                <p className="fy-trow__name">
                  {type.name}
                  <code className="fy-trow__id">{type.id}</code>
                </p>
                <p className="fy-trow__desc">{type.description || <span className="ui-muted">Sem descrição: diga quando usar.</span>}</p>
                <ul className="fy-trow__meta" aria-label="Detalhes">
                  <li>{FOR_YOU_TYPE_BEHAVIOR_LABELS[type.behavior]}</li>
                  <li>{limitsSummary(type)}</li>
                  <li className={type.createdBy === "maestro" ? "fy-trow__by--maestro" : undefined}>{FOR_YOU_TYPE_CREATOR_LABELS[type.createdBy]}</li>
                  <li>{itemsLabel(count)}</li>
                </ul>
              </div>
              <div className="fy-trow__actions">
                <button type="button" className="fy-icon-btn" onClick={() => onEdit(type)} aria-label={`Editar ${type.name}`} title="Editar" data-testid="foryou-type-edit">
                  <Icon name="pencil" size={15} />
                </button>
                {!builtin && (
                  <>
                    <button type="button" className="fy-icon-btn" onClick={() => onMerge(type)} aria-label={`Juntar ${type.name} com outro tipo`} title="Juntar com outro tipo" data-testid="foryou-type-merge">
                      <Icon name="merge" size={15} />
                    </button>
                    <button type="button" className="fy-icon-btn fy-icon-btn--danger" onClick={() => onDelete(type)} aria-label={`Excluir ${type.name}`} title="Excluir" data-testid="foryou-type-delete-button">
                      <Icon name="trash" size={15} />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type FormProps = {
  /** null = tipo novo. */
  type: ForYouTypeDef | null;
  types: readonly ForYouTypeDef[];
  onCancel: () => void;
  onSaved: (type: ForYouTypeDef, created: boolean) => void;
};

function TypeFormView({ type, types, onCancel, onSaved }: FormProps) {
  const baseId = useId();
  const [form, setForm] = useState<TypeForm>(() => formFromType(type, types));
  const [errors, setErrors] = useState<TypeFormErrors>({});
  /** Num tipo novo, o ícone segue o nome até o usuário escolher um. */
  const [iconTouched, setIconTouched] = useState(type !== null);
  const { pending, error, run } = useAsyncAction();
  const builtin = type !== null && isBuiltinForYouType(type.id);
  const set = (patch: Partial<TypeForm>) =>
    setForm((current) => {
      const next = { ...current, ...patch };
      if (!iconTouched && (patch.name !== undefined || patch.description !== undefined)) next.icon = suggestedIcon(next.name, next.description);
      return next;
    });

  const save = async () => {
    let request: (() => Promise<ForYouTypeDef>) | undefined;
    if (type) {
      const parsed = updateBody(form);
      setErrors(parsed.errors);
      if (parsed.body) request = () => api.updateForYouType(type.id, parsed.body!);
    } else {
      const parsed = createBody(form);
      setErrors(parsed.errors);
      if (parsed.body) request = () => api.createForYouType(parsed.body!);
    }
    if (!request) return;
    const saved = await run(request);
    if (saved) onSaved(saved, type === null);
  };

  const setRow = (index: number, patch: Partial<TypeForm["byWhere"][number]>) =>
    set({ byWhere: form.byWhere.map((row, i) => (i === index ? { ...row, ...patch } : row)) });

  return (
    <form
      className="ui-form fy-tform"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      noValidate
      data-testid="foryou-type-form"
    >
      <div className="fy-tform__preview" aria-hidden="true">
        <TypeBadge type={form} size={20} />
        <span className="fy-type-chip" style={typeStyle(form)}>
          <Icon name={form.icon} size={14} />
          {form.name.trim() || "Nome do tipo"}
        </span>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${baseId}-name`}>
          Nome
        </label>
        <input
          id={`${baseId}-name`}
          className="ui-input"
          value={form.name}
          maxLength={40}
          onChange={(event) => set({ name: event.currentTarget.value })}
          aria-invalid={Boolean(errors.name)}
          autoFocus
          data-testid="foryou-type-name"
        />
        {errors.name && <p className="ui-field__error">{errors.name}</p>}
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${baseId}-desc`}>
          Quando usar
        </label>
        <textarea
          id={`${baseId}-desc`}
          className="ui-input fy-tform__desc"
          value={form.description}
          maxLength={500}
          rows={2}
          onChange={(event) => set({ description: event.currentTarget.value })}
          aria-describedby={`${baseId}-desc-hint`}
          data-testid="foryou-type-description"
        />
        <p id={`${baseId}-desc-hint`} className="ui-field__hint">
          O Maestro e os agentes leem isto para escolher o tipo.
        </p>
      </div>

      <fieldset className="fy-tform__group">
        <legend className="ui-field__label">Comportamento</legend>
        <div className="fy-seg fy-tform__seg" role="group">
          {FOR_YOU_TYPE_BEHAVIORS.map((behavior) => (
            <button
              key={behavior}
              type="button"
              aria-pressed={form.behavior === behavior}
              disabled={builtin && form.behavior !== behavior}
              onClick={() => set({ behavior })}
              data-testid={`foryou-type-behavior-${behavior}`}
            >
              {FOR_YOU_TYPE_BEHAVIOR_LABELS[behavior]}
            </button>
          ))}
        </div>
        <p className="ui-field__hint">
          {builtin ? "Tipo do sistema: o comportamento não muda." : form.behavior === "pergunta" ? "O card pede uma resposta sua." : "O card mostra o texto para editar, aprovar ou recusar."}
        </p>
      </fieldset>

      <fieldset className="fy-tform__group">
        <legend className="ui-field__label">Ícone</legend>
        <div className="fy-icon-grid" role="radiogroup" aria-label="Ícone">
          {FOR_YOU_TYPE_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={form.icon === icon}
              aria-label={icon.replace("-", " ")}
              title={icon.replace("-", " ")}
              className="fy-icon-grid__item"
              style={form.icon === icon ? typeStyle(form) : undefined}
              onClick={() => {
                setIconTouched(true);
                set({ icon });
              }}
              data-testid={`foryou-type-icon-${icon}`}
            >
              <Icon name={icon} size={18} />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="fy-tform__group">
        <legend className="ui-field__label">Cor</legend>
        <div className="fy-swatches">
          {FOR_YOU_TYPE_COLORS.map((color) => (
            <label key={color} className="ui-swatch" title={FOR_YOU_TYPE_COLOR_LABELS[color]}>
              <input type="radio" name={`${baseId}-color`} checked={form.color === color} onChange={() => set({ color })} aria-label={FOR_YOU_TYPE_COLOR_LABELS[color]} data-testid={`foryou-type-color-${color}`} />
              <span className="ui-swatch__chip" style={{ background: forYouTypeColorVar(color) }} />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="fy-tform__group">
        <legend className="ui-field__label">Limite de caracteres</legend>
        <div className="fy-tform__limit">
          <input
            id={`${baseId}-limit`}
            className="ui-input ui-input--compact"
            inputMode="numeric"
            placeholder="sem limite"
            value={form.limit}
            onChange={(event) => set({ limit: event.currentTarget.value })}
            aria-label="Limite padrão"
            aria-invalid={Boolean(errors.limit)}
            data-testid="foryou-type-limit"
          />
          <span className="ui-field__hint">caracteres no texto (vazio = sem limite)</span>
        </div>
        {errors.limit && <p className="ui-field__error">{errors.limit}</p>}

        <p className="ui-field__hint fy-tform__sub">Limites conforme o “onde” do item (o começo do “onde”, sem caixa nem acento):</p>
        {form.byWhere.length > 0 && (
          <div className="fy-where" role="table" aria-label="Limites por onde">
            <div className="fy-where__head" role="row">
              <span role="columnheader">Começa com</span>
              <span role="columnheader">Máximo</span>
              <span role="columnheader">Nome no contador</span>
              <span role="columnheader" className="sr-only">
                Remover
              </span>
            </div>
            {form.byWhere.map((row, index) => (
              <div key={index} className="fy-where__row" role="row">
                <input className="ui-input ui-input--compact" value={row.match} placeholder="ex.: legenda" aria-label={`Começa com (linha ${index + 1})`} onChange={(event) => setRow(index, { match: event.currentTarget.value })} />
                <input className="ui-input ui-input--compact" value={row.max} inputMode="numeric" placeholder="2200" aria-label={`Máximo (linha ${index + 1})`} onChange={(event) => setRow(index, { max: event.currentTarget.value })} />
                <input className="ui-input ui-input--compact" value={row.name} placeholder="ex.: legenda" aria-label={`Nome no contador (linha ${index + 1})`} onChange={(event) => setRow(index, { name: event.currentTarget.value })} />
                <button type="button" className="fy-icon-btn fy-icon-btn--danger" aria-label={`Remover linha ${index + 1}`} onClick={() => set({ byWhere: form.byWhere.filter((_, i) => i !== index) })}>
                  <Icon name="cross" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {errors.byWhere && <p className="ui-field__error">{errors.byWhere}</p>}
        <button type="button" className="fy-link fy-tform__add" onClick={() => set({ byWhere: [...form.byWhere, { match: "", max: "", name: "" }] })} data-testid="foryou-type-add-where">
          <Icon name="plus" size={13} />
          Adicionar limite por “onde”
        </button>
      </fieldset>

      <fieldset className="fy-tform__group">
        <legend className="ui-field__label">Campos do item</legend>
        <label className="fy-check">
          <input type="checkbox" checked={form.to} onChange={(event) => set({ to: event.currentTarget.checked })} data-testid="foryou-type-field-to" />
          Diz para quem é (“para”)
        </label>
        <label className="fy-check">
          <input type="checkbox" checked={form.where} onChange={(event) => set({ where: event.currentTarget.checked })} data-testid="foryou-type-field-where" />
          Diz onde o texto sai (“onde”)
        </label>
      </fieldset>

      <ErrorText testId="foryou-type-error">{error}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onCancel}>
          <Icon name="back" size={14} />
          Voltar
        </button>
        <button type="submit" className="ui-button" disabled={pending} data-testid="foryou-type-save">
          {pending ? "Salvando…" : type ? "Salvar" : "Criar tipo"}
        </button>
      </div>
    </form>
  );
}

type MergeProps = {
  type: ForYouTypeDef;
  types: readonly ForYouTypeDef[];
  count: number;
  onClose: () => void;
  onMerged: (target: ForYouTypeDef) => void;
};

/** Juntar um tipo com outro: os itens vão para o escolhido e o tipo sai. */
function MergeDialog({ type, types, count, onClose, onMerged }: MergeProps) {
  const options = types.filter((candidate) => candidate.id !== type.id);
  const [into, setInto] = useState(options.find((candidate) => candidate.behavior === type.behavior)?.id ?? options[0]?.id ?? "");
  const { pending, error, run } = useAsyncAction();
  const selectId = useId();
  const target = options.find((candidate) => candidate.id === into);
  const merge = async () => {
    const merged = await run(() => api.mergeForYouType(type.id, into));
    if (merged) {
      onMerged(merged);
      onClose();
    }
  };
  return (
    <Modal title={`Juntar “${type.name}” com outro tipo`} onClose={onClose} testId="foryou-type-merge-dialog">
      <div className="ui-form">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={selectId}>
            Juntar com
          </label>
          <select id={selectId} className="ui-input" value={into} onChange={(event) => setInto(event.currentTarget.value)} data-testid="foryou-type-merge-into">
            {options.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ui-confirm">
          <p>
            {count > 0 ? `${itemsLabel(count).replace(/^./, (c) => c.toUpperCase())} de “${type.name}” ${count === 1 ? "vai" : "vão"} para “${target?.name ?? "?"}”` : `Nenhum item usa “${type.name}”`}, e “{type.name}” deixa de existir.
          </p>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose} autoFocus>
            Cancelar
          </button>
          <button type="button" className="ui-button" onClick={() => void merge()} disabled={pending || !target} data-testid="foryou-type-merge-confirm">
            {pending ? "Juntando…" : "Juntar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
