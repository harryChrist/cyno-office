import type { ReportKind, ReportList } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError, mediaFileUrl } from "../../../api/client";
import { useNavStore } from "../../../store/navStore";
import { useOfficeStore } from "../../../store/officeStore";
import { GENERATE_LABEL, REPORT_TABS, RETRO_TAB, downloadName, emptyMessage, generatedText, itemLabel, itemSub, itemsOf, selectLabel, pickSelection, type ReportTabId } from "./reportsView";
import { ReportFrame } from "./ReportFrame";
import { RetroPanel } from "./RetroPanel";
import { badgeLabel, waitingRules } from "./retroView";
import { reportsApi } from "./reportsApi";
import "../painel/painel.css";
import "./relatorios.css";

/** A lista confere de novo a cada minuto (o servidor gera o resumo do dia e a revisão no horário, sozinho). */
const REFRESH_MS = 60_000;

type Note = { tone: "ok" | "warn" | "error"; text: string; href?: string; linkText?: string };

/**
 * A aba Relatórios da Gestão: uma coluna de leitura centrada (até ~1040 px) com os períodos guardados numa faixa em cima, a barra
 * "Salvar PDF · Imagem · Markdown · Gerar agora" colada no topo ao rolar e a página do relatório já montada pelo servidor (dentro de
 * um iframe sem scripts, com a altura do conteúdo: a tela rola uma vez só). No celular a faixa vira um seletor.
 */
export function RelatoriosTab() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  return <RelatoriosView key={workspaceId ?? ""} workspaceId={workspaceId} />;
}

function RelatoriosView({ workspaceId }: { workspaceId: string | null }) {
  // `#/<ws>/gestao/relatorios/aprendemos` (o link do Painel para as regras) abre direto em "O que aprendemos".
  const initialSub = useNavStore((state) => state.sub);
  const [tab, setTab] = useState<ReportTabId>(() => (initialSub.split("/")[1] === "aprendemos" ? "retro" : "week"));
  // "O que aprendemos" não é uma lista de relatórios guardados: ela tem o próprio painel (cartões das regras).
  const retro = tab === "retro";
  const kind: ReportKind = tab === "retro" ? "week" : tab;
  const waiting = waitingRules(useOfficeStore((state) => state.forYou));
  const [list, setList] = useState<ReportList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [frame, setLoaded] = useState<{ key: string; html: string } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<"generate" | "image" | "markdown" | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!workspaceId) return;
    let stale = false;
    reportsApi
      .list(workspaceId)
      .then((next) => {
        if (stale) return;
        setList(next);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!stale) setError(describeError(failure));
      });
    return () => {
      stale = true;
    };
  }, [workspaceId, tick]);

  const items = useMemo(() => itemsOf(list, kind), [list, kind]);
  const current = items.find((item) => item.period === pickSelection(items, selected)) ?? null;
  // O relatório mesmo muda quando o período, a hora em que foi gerado ou o parágrafo do Maestro mudam (a lista é refeita todo minuto).
  const frameKey = current && !retro ? `${kind}|${current.period}|${current.generatedAt}|${current.hasAi}` : null;
  const html = frame && frame.key === frameKey ? frame.html : null;
  const htmlError = failed && failed.key === frameKey ? failed.message : null;
  const currentPeriod = current?.period ?? null;

  useEffect(() => {
    if (!workspaceId || !frameKey || !currentPeriod) return;
    let stale = false;
    reportsApi
      .html(workspaceId, kind, currentPeriod, window.location.origin)
      .then((text) => {
        if (!stale) setLoaded({ key: frameKey, html: text });
      })
      .catch((failure: unknown) => {
        if (!stale) setFailed({ key: frameKey, message: describeError(failure) });
      });
    return () => {
      stale = true;
    };
  }, [workspaceId, kind, frameKey, currentPeriod]);

  const generate = async () => {
    if (!workspaceId || busy) return;
    setBusy("generate");
    setNote(null);
    try {
      const result = await reportsApi.generate(workspaceId, kind);
      reload();
      setSelected(result.report.period);
      setNote(result.note ? { tone: "warn", text: result.note } : { tone: "ok", text: result.report.final ? "Relatório gerado e guardado." : "Relatório parcial gerado: ele será refeito quando o período fechar." });
    } catch (failure) {
      setNote({ tone: "error", text: describeError(failure) });
    } finally {
      setBusy(null);
    }
  };

  const makeImage = async () => {
    if (!workspaceId || !current || busy) return;
    setBusy("image");
    setNote(null);
    try {
      const media = await reportsApi.image(workspaceId, kind, current.period);
      setNote({ tone: "ok", text: "Imagem guardada na Biblioteca de mídia.", href: mediaFileUrl(workspaceId, media.id), linkText: "Abrir a imagem" });
    } catch (failure) {
      setNote({ tone: "error", text: describeError(failure) });
    } finally {
      setBusy(null);
    }
  };

  const downloadMarkdown = async () => {
    if (!workspaceId || !current || busy) return;
    setBusy("markdown");
    setNote(null);
    try {
      const text = await reportsApi.markdown(workspaceId, kind, current.period);
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(kind, current.period, "md");
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (failure) {
      setNote({ tone: "error", text: describeError(failure) });
    } finally {
      setBusy(null);
    }
  };

  // PDF = o "Salvar como PDF" do próprio navegador, com a página do relatório (o @media print dela vira A4).
  const savePdf = () => frameRef.current?.contentWindow?.print();

  const imageOff = list !== null && !list.imageAvailable;
  const loaded = list !== null;

  return (
    <section className="page rel" aria-labelledby="rel-title" data-testid="page-relatorios">
      <header className="rel__head">
        <div>
          <h2 className="painel__title" id="rel-title">
            Relatórios
          </h2>
          <p className="painel__sub">Calculados pelo servidor e guardados congelados; o dólar é equivalente à API.</p>
        </div>
        <div className="rel__kinds" role="tablist" aria-label="Tipo de relatório">
          {[...REPORT_TABS, RETRO_TAB].map((option) => (
            <button key={option.id} type="button" role="tab" aria-selected={tab === option.id} className={`rel__kind${tab === option.id ? " is-on" : ""}`} onClick={() => setTab(option.id)} data-testid={`rel-kind-${option.id}`}>
              {option.label}
              {option.id === "retro" && waiting > 0 && (
                <span className="rel__badge" title={badgeLabel(waiting)} aria-label={badgeLabel(waiting)} data-testid="rel-retro-badge">
                  {waiting}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {retro && workspaceId && <RetroPanel workspaceId={workspaceId} />}

      {!retro && error && !list && (
        <p className="ui-error" role="alert" data-testid="rel-error">
          Não deu para carregar os relatórios. {error}{" "}
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={reload}>
            Tentar de novo
          </button>
        </p>
      )}
      {!retro && !loaded && !error && <p className="page__empty">Carregando os relatórios…</p>}

      {!retro && loaded && items.length === 0 && (
        <div className="rel__empty" data-testid="rel-empty">
          <p className="rel__empty-title">{emptyMessage(kind, list?.settings)}</p>
          <p className="rel__empty-line">Quando o horário chega o servidor monta o relatório sozinho, só com os números já calculados, e o guarda aqui. Se quiser ver como fica agora, gere um parcial.</p>
          <button type="button" className="ui-button ui-button--primary" onClick={() => void generate()} disabled={busy !== null} aria-busy={busy === "generate"} data-testid="rel-generate-empty">
            {busy === "generate" ? "Gerando…" : GENERATE_LABEL[kind]}
          </button>
          {note && <NoteLine note={note} />}
        </div>
      )}

      {!retro && loaded && items.length > 0 && (
        <div className="rel__body">
          <label className="rel__select">
            <span className="rel__select-label">Relatório</span>
            <select value={current?.period ?? ""} onChange={(event) => setSelected(event.currentTarget.value)} data-testid="rel-select">
              {items.map((item) => (
                <option key={item.period} value={item.period}>
                  {selectLabel(item)}
                </option>
              ))}
            </select>
            {current && <span className="rel__select-sub">{itemSub(current)}</span>}
          </label>
          <div className="rel__main">
            <div className="rel__bar" role="toolbar" aria-label="Ações do relatório" title={current ? generatedText(current) : undefined}>
              <nav className="rel__list" aria-label="Relatórios guardados" data-testid="rel-list">
                  {items.map((item) => (
                    <button key={item.period} type="button" className={`rel__item${item.period === current?.period ? " is-on" : ""}`} aria-current={item.period === current?.period ? "true" : undefined} onClick={() => setSelected(item.period)} title={itemSub(item)} data-testid="rel-item">
                      <span className="rel__item-title">{itemLabel(item)}</span>
                      <span className="rel__item-sub">{itemSub(item)}</span>
                    </button>
                  ))}
          </nav>
              <div className="rel__bar-actions">
                <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={savePdf} disabled={!html} data-testid="rel-pdf">
                  Salvar PDF
                </button>
                <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void makeImage()} disabled={!html || imageOff || busy !== null} aria-busy={busy === "image"} title={imageOff ? "Ligue o navegador do workspace para gerar a imagem" : "Guarda um PNG da página na Biblioteca de mídia"} data-testid="rel-image">
                  {busy === "image" ? "Gerando…" : "Imagem"}
                </button>
                <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void downloadMarkdown()} disabled={!html || busy !== null} data-testid="rel-markdown">
                  Markdown
                </button>
                <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => void generate()} disabled={busy !== null} aria-busy={busy === "generate"} title="Gera o relatório do período de agora (parcial, até ele fechar). Um relatório já fechado não muda." data-testid="rel-generate">
                  {busy === "generate" ? "Gerando…" : "Gerar agora"}
                </button>
              </div>
            </div>
            {imageOff && (
              <p className="rel__hint" data-testid="rel-image-hint">
                Ligue o navegador do workspace para gerar a imagem (Configurações &gt; Acesso). O PDF e o Markdown continuam funcionando.
              </p>
            )}
            {note && <NoteLine note={note} />}
            {htmlError && (
              <p className="ui-error" role="alert">
                Não deu para abrir o relatório. {htmlError}
              </p>
            )}
            {!html && !htmlError && <p className="page__empty">Abrindo o relatório…</p>}
            {html && <ReportFrame ref={frameRef} html={html} title={current ? `${itemLabel(current)}` : "Relatório"} />}
          </div>
        </div>
      )}
    </section>
  );
}

function NoteLine({ note }: { note: Note }) {
  return (
    <p className={`rel__note rel__note--${note.tone}`} role={note.tone === "error" ? "alert" : "status"} data-testid="rel-note">
      {note.text}
      {note.href && (
        <>
          {" "}
          <a href={note.href} target="_blank" rel="noopener noreferrer">
            {note.linkText}
          </a>
        </>
      )}
    </p>
  );
}
