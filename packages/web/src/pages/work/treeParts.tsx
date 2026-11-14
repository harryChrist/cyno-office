import { PROJECT_PRIORITY_LABELS, type Agent, type ProjectPriority, type ProjectTaskStatus } from "@cyno/shared";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AgentAvatar } from "./Agent";
import { TREE_STATUS_LABEL } from "./taskTreeView";

/** Peças pequenas da árvore e do painel: ícone de estado, pilha de avatares, bandeira de prioridade e o popover da linha. */

/** Ícone de estado de uma linha (um desenho por estado, com o rótulo para leitor de tela). */
export function StatusIcon({ status, size = 16 }: { status: ProjectTaskStatus; size?: number }) {
  const label = TREE_STATUS_LABEL[status];
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", strokeWidth: 1.6, role: "img", "aria-label": label } as const;
  return (
    <span className={`tt-status tt-status--${status}`} title={label}>
      {status === "concluida" ? (
        <svg {...common} stroke="currentColor">
          <circle cx="8" cy="8" r="6.4" fill="currentColor" fillOpacity="0.18" />
          <path d="M5 8.2l2 2 4-4.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : status === "em_andamento" ? (
        <svg {...common} stroke="currentColor">
          <circle cx="8" cy="8" r="6.4" />
          <path d="M8 1.6a6.4 6.4 0 0 1 0 12.8z" fill="currentColor" stroke="none" />
        </svg>
      ) : status === "esperando_voce" ? (
        <svg {...common} stroke="currentColor">
          <circle cx="8" cy="8" r="6.4" fill="currentColor" fillOpacity="0.18" />
          <path d="M6.4 5.6v4.8M9.6 5.6v4.8" strokeLinecap="round" />
        </svg>
      ) : status === "falhou" ? (
        <svg {...common} stroke="currentColor">
          <circle cx="8" cy="8" r="6.4" fill="currentColor" fillOpacity="0.18" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" strokeLinecap="round" />
        </svg>
      ) : status === "cancelada" ? (
        <svg {...common} stroke="currentColor">
          <circle cx="8" cy="8" r="6.4" />
          <path d="M4.6 11.4l6.8-6.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg {...common} stroke="currentColor" strokeDasharray={status === "backlog" ? "2.4 2.4" : undefined}>
          <circle cx="8" cy="8" r="6.4" />
        </svg>
      )}
    </span>
  );
}

/** Até 3 avatares sobrepostos e o "+N"; tooltip com os nomes (o primeiro é o responsável). */
export function AvatarStack({ ids, more, agents, empty = "Sem responsável" }: { ids: readonly string[]; more: number; agents: ReadonlyMap<string, Agent>; empty?: string }) {
  if (ids.length === 0) return <span className="tt-nobody" title={empty} aria-label={empty} />;
  const names = ids.map((id) => agents.get(id)?.name ?? id);
  return (
    <span className="tt-stack" title={`${names.join(", ")}${more > 0 ? ` e mais ${more}` : ""}`} aria-label={`Responsáveis: ${names.join(", ")}${more > 0 ? ` e mais ${more}` : ""}`}>
      {ids.map((id) => (
        <span key={id} className="tt-stack__one">
          <AgentAvatar agent={agents.get(id)} />
        </span>
      ))}
      {more > 0 && <span className="tt-stack__more">+{more}</span>}
    </span>
  );
}

/** Bandeira de prioridade (cor por nível) e o rótulo. */
export function PriorityFlag({ priority, label = true }: { priority: ProjectPriority; label?: boolean }) {
  const text = PROJECT_PRIORITY_LABELS[priority];
  return (
    <span className={`tt-prio tt-prio--${priority}`} title={`Prioridade ${text.toLowerCase()}`}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M3 1.5v13h1.6V9.6h8L11 5.6l2.6-4.1H4.6V1.5z" />
      </svg>
      {label && <span className="tt-prio__text">{text}</span>}
    </span>
  );
}

type PopoverProps = {
  /** Botão que abre (recebe o clique e o estado). */
  anchor: (props: { open: boolean; toggle: () => void; ref: (node: HTMLButtonElement | null) => void }) => ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  testId?: string;
  align?: "start" | "end";
};

/** Popover ancorado (portal, posição fixa: não é cortado pela rolagem da árvore). Fecha com Esc e clicando fora. */
export function Popover({ anchor, label, children, testId, align = "start" }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  /** Guarda onde está o botão quando abre; a posição final sai da altura de verdade do painel (veja abaixo). */
  const place = (node: HTMLButtonElement) => {
    setRect(node.getBoundingClientRect());
    setPos(null);
  };

  /** Embaixo do botão se couber; senão em cima (sem cobrir o botão nem sair da tela); o painel rola se nenhum lado couber. */
  useLayoutEffect(() => {
    if (!open || !rect || !panel.current) return;
    const width = 250;
    const margin = 8;
    const height = panel.current.offsetHeight;
    const left = align === "end" ? Math.max(margin, rect.right - width) : Math.min(rect.left, window.innerWidth - width - margin);
    const roomBelow = window.innerHeight - rect.bottom - 6 - margin;
    const roomAbove = rect.top - 6 - margin;
    if (height <= roomBelow) setPos({ top: rect.bottom + 6, left: Math.max(margin, left) });
    else if (height <= roomAbove) setPos({ top: rect.top - 6 - height, left: Math.max(margin, left) });
    else if (roomAbove > roomBelow) setPos({ top: margin, left: Math.max(margin, left), maxHeight: roomAbove });
    else setPos({ top: rect.bottom + 6, left: Math.max(margin, left), maxHeight: roomBelow });
  }, [open, rect, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || button?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, button]);

  return (
    <>
      {anchor({ open, toggle: () => {
          if (!open && button) place(button);
          setOpen((current) => !current);
        },
        ref: setButton })}
      {open &&
        createPortal(
          <div ref={panel} className="tt-pop" role="dialog" aria-label={label} onClick={(event) => event.stopPropagation()} style={pos ? { top: pos.top, left: pos.left, ...(pos.maxHeight ? { maxHeight: pos.maxHeight } : {}) } : { top: 0, left: 0, visibility: "hidden" }} data-testid={testId}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}
