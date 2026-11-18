import { GLOBAL_BRAIN_ID, type ListBrainsResponse } from "@cyno/shared";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, describeError } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { BrainList } from "./BrainList";
import { BrainOverview } from "./BrainOverview";
import { brainHash, brainLevel, buildWikiIndex, doneSignature, parseBrainHash } from "./brainView";
import "./brain.css";
import { NoteList } from "./NoteList";
import { AgentRulesReader } from "./AgentRules";
import { NoteReader } from "./NoteReader";

/** O hash do endereço como store externo (links de nota mudam o hash; voltar/avançar também). */
function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}
const readHash = () => window.location.hash;

type ListState = { key: string; brains: ListBrainsResponse | null; error: string | null };

/**
 * Navegador do Cérebro do workspace atual: Cérebros à esquerda, notas no meio, nota aberta à
 * direita. O Cérebro e a nota escolhidos ficam no endereço (`#/<ws>/cerebro/<cérebro>/<nota>`).
 */
function BrainBrowser({ workspaceId }: { workspaceId: string }) {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  const selection = useMemo(() => parseBrainHash(hash, workspaceId), [hash, workspaceId]);
  const office = useOfficeStore((state) => state.office);
  // Tarefa concluída = nota nova no Cérebro: recarrega a lista.
  const done = doneSignature(office?.tasks);
  const [retry, setRetry] = useState(0);
  const key = `${done}|${retry}`;
  const [list, setList] = useState<ListState>({ key: "", brains: null, error: null });
  const [query, setQuery] = useState("");
  // Uma regra de agente foi salva: o bloco "Regras por agente" recarrega o estado de cada um.
  const [rulesVersion, setRulesVersion] = useState(0);

  useEffect(() => {
    let stale = false;
    api
      .listBrains()
      .then((brains) => !stale && setList({ key, brains, error: null }))
      .catch((error: unknown) => !stale && setList((previous) => ({ key, brains: previous.brains, error: describeError(error) })));
    return () => {
      stale = true;
    };
  }, [key]);

  const brains = list.brains;
  const wikiIndex = useMemo(() => buildWikiIndex(brains ?? []), [brains]);
  const loading = list.key !== key;
  const activeId = selection.brainId ?? GLOBAL_BRAIN_ID;
  const activeBrain = brains?.find((brain) => brain.id === activeId);
  const readingAgent = selection.agentId !== undefined;
  const reading = selection.file !== null || readingAgent;
  const now = useNow();

  if (!brains) {
    return (
      <div className="page__body" aria-busy={!list.error}>
        {list.error ? (
          <div className="brain-error" role="alert">
            <p>Não foi possível ler o Cérebro: {list.error}</p>
            <button type="button" className="ui-button ui-button--small" onClick={() => setRetry((value) => value + 1)}>
              Tentar de novo
            </button>
          </div>
        ) : (
          <p className="page__empty">Carregando os Cérebros…</p>
        )}
      </div>
    );
  }

  return (
    <div
      className="brain-browser"
      data-level={brainLevel(selection)}
      data-reading={reading}
      data-loading={loading}
      aria-busy={loading}
      data-testid="brain-browser"
    >
      {list.error && (
        <p className="brain-error brain-browser__warning" role="alert">
          A lista pode estar desatualizada: {list.error}{" "}
          <button type="button" className="ui-button ui-button--small" onClick={() => setRetry((value) => value + 1)}>
            Tentar de novo
          </button>
        </p>
      )}
      <BrainList workspaceId={workspaceId} brains={brains} activeId={activeId} selected={selection.brainId !== null} office={office} />
      {activeBrain ? (
        <NoteList workspaceId={workspaceId} brain={activeBrain} activeFile={selection.file} activeAgentId={selection.agentId ?? null} rulesVersion={rulesVersion} query={query} onQueryChange={setQuery} now={now} office={office} />
      ) : (
        <section className="brain-col brain-col--notes">
          <a className="brain-back" href={brainHash(workspaceId, null)}>
            ← Cérebros
          </a>
          <p className="brain-empty">Este Cérebro não existe mais neste workspace.</p>
        </section>
      )}
      {readingAgent ? (
        <AgentRulesReader
          key={`${activeId}/@agente/${selection.agentId}`}
          workspaceId={workspaceId}
          brainId={activeId}
          agentId={selection.agentId!}
          agentName={office?.agents.find((agent) => agent.id === selection.agentId)?.name ?? selection.agentId!}
          onSaved={() => setRulesVersion((value) => value + 1)}
        />
      ) : reading ? (
        <NoteReader
          key={`${activeId}/${selection.file}`}
          workspaceId={workspaceId}
          brainId={activeId}
          file={selection.file!}
          brain={activeBrain}
          office={office}
          wikiIndex={wikiIndex}
          now={now}
          onRulesSaved={() => setRetry((value) => value + 1)}
        />
      ) : activeBrain ? (
        <BrainOverview workspaceId={workspaceId} brain={activeBrain} office={office} now={now} />
      ) : (
        <div className="brain-col brain-col--reader brain-overview" />
      )}
    </div>
  );
}

/** Agora (ms), renovado a cada minuto: as datas relativas ("há 5 min") andam sozinhas. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Página "Cérebro": as notas do workspace atual. */
export function BrainPage() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  return (
    <section className="page page--brain page--fill" aria-labelledby="page-title-cerebro" data-testid="page-cerebro">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-cerebro" className="page__title">
            Cérebro
          </h2>
          <p className="page__subtitle">As regras e as notas do lobby, da Sala do Maestro e de cada sala. Os agentes recebem as regras em toda tarefa e buscam o resto quando precisam.</p>
        </div>
      </header>
      {workspaceId ? <BrainBrowser key={workspaceId} workspaceId={workspaceId} /> : <p className="page__empty">Escolha um workspace.</p>}
    </section>
  );
}
