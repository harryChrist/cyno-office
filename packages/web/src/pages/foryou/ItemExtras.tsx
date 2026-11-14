import { FOR_YOU_REASON_MAX, type ForYouItem } from "@cyno/shared";
import { useEffect, useId, useRef, useState } from "react";
import { formatDateTime } from "../../ui/format";
import { ConfirmDialog } from "../../ui/widgets";
import { cancelLabel, canDiscard, updateBadge } from "./forYouView";
import { Icon } from "./icons";

/** Descarta o item (o motivo é opcional). Quem chama mostra o aviso e trata o erro. */
export type DiscardHandler = (item: ForYouItem, reason: string) => Promise<unknown>;

/**
 * Menu "⋯" do card pendente: por enquanto só "Descartar" (abre a confirmação com o motivo
 * opcional). Fecha com Esc, clique fora ou ao escolher.
 */
export function ItemMenu({ item, onDiscard }: { item: ForYouItem; onDiscard: DiscardHandler }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!canDiscard(item)) return null;
  return (
    <div className="fy-menu" ref={root}>
      <button
        type="button"
        className="fy-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Mais ações de ${item.id}`}
        title="Mais ações"
        onClick={() => setOpen((current) => !current)}
        data-testid="foryou-menu"
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <ul id={menuId} className="fy-menu__list" role="menu" aria-label={`Ações de ${item.id}`}>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="fy-menu__item fy-menu__item--danger"
              onClick={() => {
                setOpen(false);
                setConfirming(true);
              }}
              data-testid="foryou-discard"
            >
              <Icon name="trash" size={14} />
              Descartar
            </button>
          </li>
        </ul>
      )}
      {confirming && <DiscardDialog item={item} onDiscard={onDiscard} onClose={() => setConfirming(false)} />}
    </div>
  );
}

/** Confirmação do "Descartar", com o motivo opcional (vai para quem pediu e fica em Cancelados). */
function DiscardDialog({ item, onDiscard, onClose }: { item: ForYouItem; onDiscard: DiscardHandler; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const fieldId = useId();
  const holdsTask = Boolean(item.taskId);
  return (
    <ConfirmDialog
      title={`Descartar ${item.id}?`}
      message={
        <div className="fy-discard">
          <p>
            O item sai dos pendentes e fica em <strong>Cancelados</strong>.{" "}
            {holdsTask ? "Se uma tarefa esperava por ele, ela segue sem a sua resposta." : ""} Quem pediu fica sabendo na próxima vez que trabalhar (ninguém é acordado só por isso).
          </p>
          <label htmlFor={fieldId} className="fy-field__label">
            Motivo <span className="fy-field__hint">· opcional</span>
          </label>
          <textarea
            id={fieldId}
            className="ui-input fy-textarea fy-textarea--note"
            rows={2}
            maxLength={FOR_YOU_REASON_MAX}
            value={reason}
            placeholder="Ex.: já respondi na conversa"
            onChange={(event) => setReason(event.currentTarget.value)}
            data-testid="foryou-discard-reason"
          />
        </div>
      }
      confirmLabel="Descartar"
      pendingLabel="Descartando…"
      onConfirm={() => onDiscard(item, reason.trim())}
      onClose={onClose}
      testId="foryou-discard-dialog"
    />
  );
}

/**
 * Selo "Atualizado pelo Maestro" (ou pelo agente). O motivo aparece no hover (title) e ao clicar,
 * com o histórico das alterações.
 */
export function UpdatedChip({ item, agentName, open, onToggle }: { item: ForYouItem; agentName?: string; open: boolean; onToggle: () => void }) {
  const badge = updateBadge(item, agentName);
  if (!badge) return null;
  return (
    <li className="fy-chip--updated">
      <button type="button" className="fy-chip-btn" aria-expanded={open} title={badge.reason ? `Motivo: ${badge.reason}` : "Alterado depois de enviado"} onClick={onToggle} data-testid="foryou-updated">
        <Icon name="refresh" size={12} />
        {badge.label}
        {badge.count > 1 ? ` · ${badge.count}x` : ""}
      </button>
    </li>
  );
}

/** Histórico das alterações (aberto pelo selo). */
export function UpdateHistory({ item, agentName }: { item: ForYouItem; agentName?: string }) {
  const badge = updateBadge(item, agentName);
  if (!badge) return null;
  return (
    <ul className="fy-history" data-testid="foryou-update-history">
      {badge.entries.map((entry) => (
        <li key={entry.at}>
          <span className="fy-history__when">{formatDateTime(entry.at)}</span> {updateBadge({ history: [entry] }, agentName)?.label}
          {entry.reason ? `: ${entry.reason}` : ""}
        </li>
      ))}
    </ul>
  );
}

/** Faixa do item cancelado: quem cancelou e o motivo. */
export function CancelledNote({ item, agentName }: { item: ForYouItem; agentName?: string }) {
  const label = cancelLabel(item, agentName);
  if (!label) return null;
  return (
    <p className="fy-card__cancelled" data-testid="foryou-cancelled">
      <Icon name="cross" size={13} />
      <span>
        <strong>{label}</strong>
        {item.cancelReason ? `: ${item.cancelReason}` : ""}
        {item.decidedAt ? <span className="fy-card__cancelled-when"> · {formatDateTime(item.decidedAt)}</span> : null}
      </span>
    </p>
  );
}
