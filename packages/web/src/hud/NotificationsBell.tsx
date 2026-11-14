import { isSelfResolving, tourOrder } from "@cyno/shared";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { openAlert } from "../attention/openAlert";
import { useAttentionStore } from "../store/attentionStore";
import { pendingCount } from "../store/forYouItems";
import { useForYouTypesSheet } from "../store/forYouTypesSheet";
import { useNoticesStore } from "../store/notices";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useActivityStore } from "../ui/activity";
import { FeedItem, useNow } from "../ui/ActivityFeed";
import { formatAgo } from "../ui/format";
import { usePopover } from "./usePopover";
import "./attention.css";

/** Quantas atividades o popover do sino mostra. */
export const BELL_RECENT = 6;

/** Quantas atividades o painel de notificações (ao lado da barra lateral) mostra: tem a altura toda. */
export const PANEL_RECENT = 30;

/** Lista das últimas atividades (só monta com o popover aberto). */
function RecentActivity({ limit }: { limit: number }) {
  const entries = useActivityStore((state) => state.entries);
  const now = useNow();
  if (entries.length === 0) return <p className="bell__empty">Nada aconteceu ainda.</p>;
  return (
    <ol className="feed__list bell__list" data-testid="bell-list">
      {entries.slice(0, limit).map((entry) => (
        <FeedItem key={entry.key} entry={entry} now={now} idPrefix="bell" />
      ))}
    </ol>
  );
}

/** "Esperando você": os alertas abertos da cadeia de atenção, do mais antigo ao mais novo, cada um com o botão que leva ao lugar (nunca decide nada). */
function WaitingForYou({ onOpen }: { onOpen: () => void }) {
  const open = useAttentionStore((state) => state.open);
  const markSeen = useAttentionStore((state) => state.markSeen);
  const list = useMemo(() => tourOrder(open), [open]);
  const now = useNow();
  if (list.length === 0) return null;
  return (
    <section aria-label="Esperando você" data-testid="bell-waiting">
      <h3 className="bell__section-title">Esperando você</h3>
      <ul className="bell__waiting">
        {list.map((alert) => (
          <li key={alert.key} className={`bell__wait${alert.needsOwner ? "" : " bell__wait--soft"}`} data-testid="bell-wait">
            <div>
              <p className="bell__wait-text">{alert.text}</p>
              <p className="bell__wait-meta">
                {[alert.agentName, alert.workspaceName].filter(Boolean).join(" · ")}
                {alert.agentName || alert.workspaceName ? " · " : ""}
                <time dateTime={alert.at}>{formatAgo(alert.at, now)}</time>
              </p>
            </div>
            <div className="bell__wait-actions">
              <button
                type="button"
                className="ui-button ui-button--small"
                onClick={() => {
                  onOpen();
                  openAlert(alert);
                }}
                data-testid="bell-wait-open"
              >
                {alert.needsOwner ? "Responder" : "Abrir"}
              </button>
              {!alert.needsOwner && !isSelfResolving(alert.kind) && (
                <button type="button" className="ui-link" onClick={() => void markSeen(alert.key)} data-testid="bell-wait-seen">
                  Visto
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Avisos que não são de tarefa (ex.: o Maestro criou um tipo de aprovação), com o link para ver. */
function Notices({ onOpen }: { onOpen: () => void }) {
  const notices = useNoticesStore((state) => state.notices);
  const now = useNow();
  if (notices.length === 0) return null;
  return (
    <ul className="bell__notices" aria-label="Avisos" data-testid="bell-notices">
      {notices.map((notice) => (
        <li key={notice.key} className={`bell__notice${notice.alert ? " bell__notice--alert" : ""}`} data-testid={`bell-notice-${notice.target}`}>
          <span className="bell__notice-dot" aria-hidden="true" />
          <div>
            <p className="bell__notice-text">{notice.text}</p>
            <p className="bell__notice-meta">
              <time dateTime={notice.at}>{formatAgo(notice.at, now)}</time> ·{" "}
              <button
                type="button"
                className="ui-link"
                onClick={() => {
                  onOpen();
                  if (notice.target === "gestao") useNavStore.getState().go("gestao", "rotinas");
                  else useForYouTypesSheet.getState().show();
                }}
              >
                {notice.target === "gestao" ? "Abrir Gestão" : "Ver tipos"}
              </button>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Pendentes do "Para você", avisos não lidos e o rótulo acessível do sino (barra de cima e lateral). */
export function useNotificationsSummary() {
  const pending = useOfficeStore((state) => pendingCount(state.forYou));
  const unread = useNoticesStore((state) => state.unread);
  const parts = [pending > 0 ? `${pending} ${pending === 1 ? "pendente" : "pendentes"} em Aprovações` : "", unread > 0 ? `${unread} ${unread === 1 ? "aviso novo" : "avisos novos"}` : ""].filter(Boolean);
  const label = parts.length > 0 ? `Notificações: ${parts.join(", ")}` : "Notificações";
  return { pending, unread, label };
}

/** Desenho do sino (traço, grade 24×24). */
export function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/**
 * Conteúdo das notificações (cabeçalho, avisos, últimas atividades e "Ver tudo"): o popover do sino
 * e o painel que abre ao lado da barra lateral mostram o mesmo.
 */
export function NotificationsContent({ onClose, limit = BELL_RECENT, title = "Atividade recente", titleId }: { onClose: () => void; limit?: number; title?: string; titleId?: string }) {
  const pending = useOfficeStore((state) => pendingCount(state.forYou));
  const go = useNavStore((state) => state.go);
  return (
    <>
      <header className="bell__head">
        <h2 className="bell__title" id={titleId}>
          {title}
        </h2>
        {pending > 0 && <span className="ui-badge ui-badge--attention">{pending === 1 ? "1 pendente" : `${pending} pendentes`}</span>}
      </header>
      <div className="bell__body">
        <WaitingForYou onOpen={onClose} />
        <Notices onOpen={onClose} />
        <RecentActivity limit={limit} />
      </div>
      <footer className="bell__foot">
        <button
          type="button"
          className="ui-link"
          onClick={() => {
            onClose();
            go("para-voce");
          }}
          data-testid="bell-see-all"
        >
          Ver tudo em Aprovações →
        </button>
      </footer>
    </>
  );
}

/**
 * Sino da barra: o selo conta os pendentes do "Para você" (um ponto marca avisos novos, como um
 * tipo criado pelo Maestro); o popover mostra os avisos e as últimas atividades.
 */
export function NotificationsBell() {
  const { pending, unread, label } = useNotificationsSummary();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, rootRef, buttonRef);

  return (
    <div className="bell" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="topbar__icon-button bell__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => {
          if (!open) useNoticesStore.getState().markRead();
          setOpen((on) => !on);
        }}
        data-testid="bell"
      >
        <BellIcon />
        {pending > 0 && (
          <span className="bell__count" aria-hidden="true" data-testid="bell-count">
            {pending > 99 ? "99+" : pending}
          </span>
        )}
        {unread > 0 && <span className="bell__dot" aria-hidden="true" data-testid="bell-dot" />}
      </button>
      {open && (
        <section id={popoverId} className="bell__popover" aria-label="Últimas atividades" data-testid="bell-popover">
          <NotificationsContent onClose={close} />
        </section>
      )}
    </div>
  );
}
