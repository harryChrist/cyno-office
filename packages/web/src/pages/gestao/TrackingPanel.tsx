import type { TrackedItemChange, TrackedItemsResponse } from "@cyno/shared";
import { useEffect, useState } from "react";
import { api, describeError } from "../../api/client";
import { useRoutinesStore } from "../../store/routinesStore";
import { formatTime } from "../../ui/format";
import { ErrorText } from "../../ui/widgets";
import { ItemDetail } from "./ItemDetail";
import { ItemsTable } from "./ItemsTable";
import { trackingText } from "./gestaoView";
import { changesByDay } from "./routineView";

/**
 * Parte do detalhe que é só do Acompanhamento: o resumo dos itens, as mudanças recentes e a tabela completa
 * (abrir um item mostra o histórico). Recarrega a cada evento de rotina: o servidor avisa quando um item muda.
 */
export function TrackingPanel({ routineId }: { routineId: string }) {
  const version = useRoutinesStore((state) => state.version);
  const [data, setData] = useState<TrackedItemsResponse | null>(null);
  const [changes, setChanges] = useState<TrackedItemChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  /** Sobe depois de uma ação do usuário (parar, retomar, corrigir): recarrega sem esperar o evento do servidor. */
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getRoutineItems(routineId), api.getRoutineChanges(routineId, 72)])
      .then(([items, recent]) => {
        if (cancelled) return;
        setData(items);
        setChanges(recent.changes);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [routineId, version, reload]);

  if (error && !data) return <ErrorText>{error}</ErrorText>;
  if (!data) return <p className="goal__muted">Carregando os itens…</p>;
  const open = openId ? data.items.find((item) => item.id === openId) : undefined;
  const days = changesByDay(changes, new Date());

  return (
    <>
      <section className="gdetail__section" aria-label="Itens acompanhados" data-testid="tracking-panel">
        <h4 className="gdetail__h">Itens acompanhados</h4>
        <p className="goal__tracking" data-testid="tracking-summary">
          {trackingText(data.summary)}
          {data.summary.due > 0 ? ` · ${data.summary.due} para conferir` : ""}
        </p>
        {error && <ErrorText>{error}</ErrorText>}
        {open ? (
          <ItemDetail key={open.id + open.history.length} routineId={routineId} item={open} fields={data.fields} statuses={data.statuses} onBack={() => setOpenId(null)} onChanged={() => setReload((n) => n + 1)} />
        ) : (
          <ItemsTable items={data.items} fields={data.fields} statuses={data.statuses} onOpen={(item) => setOpenId(item.id)} />
        )}
      </section>

      {!open && (
        <section className="gdetail__section" aria-label="Mudanças recentes" data-testid="tracking-changes">
          <h4 className="gdetail__h">Mudanças recentes</h4>
          {days.length === 0 && <p className="goal__muted">Nada mudou nos últimos 3 dias.</p>}
          <ul className="chg">
            {days.map((day) => (
              <li key={day.day} className="chg__day">
                <p className="chg__summary">
                  <strong>{day.label}:</strong> {day.summary}
                </p>
                <ul className="chg__list">
                  {day.changes.slice(0, 6).map((change, index) => (
                    <li key={`${change.at}-${change.itemId}-${index}`} className="chg__item">
                      <span className="itl__when">{formatTime(change.at)}</span>
                      <button type="button" className="chg__text" onClick={() => setOpenId(change.itemId)}>
                        {change.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
