import { useEffect, useMemo, useState } from "react";
import { appsApi } from "../../../api/libraryApps";
import { useLibraryAppsStore } from "../../../store/libraryAppsStore";
import { useLibraryStore } from "../../../store/libraryStore";
import { useAsyncAction } from "../../../ui/useAsyncAction";
import { ErrorText } from "../../../ui/widgets";
import { GrantDialog } from "../GrantDialog";
import { AppCardView } from "./AppCardView";
import { appView, formatBytes, hasUpdate } from "./appsView";
import { InstallDialog } from "./InstallDialog";
import "./apps.css";

/**
 * Aba Apps: os apps sugeridos (projetos open source da comunidade, do GitHub). Nada vem instalado:
 * quem usa o Cyno instala se quiser, depois de ver o plano. A instalação é limpa (tudo em
 * `data/platform/apps/<app>/`), registra o MCP do app na Biblioteca sozinha e roda um mini teste.
 */
export function LibraryAppsTab() {
  const listing = useLibraryAppsStore((state) => state.listing);
  const loadError = useLibraryAppsStore((state) => state.error);
  const connectors = useLibraryStore((state) => state.connectors);
  const [installing, setInstalling] = useState<string | null>(null);
  const [granting, setGranting] = useState<string | null>(null);
  const [grantingSkillId, setGrantingSkillId] = useState<string | null>(null);
  const skills = useLibraryStore((state) => state.skills);
  const clean = useAsyncAction();

  useEffect(() => {
    void useLibraryAppsStore.getState().load();
    void useLibraryStore.getState().load();
    void useLibraryStore.getState().loadSkills();
  }, []);

  const cards = useMemo(() => listing?.cards ?? [], [listing]);
  const available = useMemo(() => cards.filter((card) => appView(card) !== "em-breve" && appView(card) !== "em-avaliacao"), [cards]);
  const soon = useMemo(() => cards.filter((card) => appView(card) === "em-breve" || appView(card) === "em-avaliacao"), [cards]);
  const installedCount = cards.filter((card) => card.app?.state === "instalado").length;
  const updates = cards.filter(hasUpdate).length;
  const grantingSkill = grantingSkillId ? (skills ?? []).find((skill) => skill.id === grantingSkillId) : undefined;
  const grantingConnector = granting ? (connectors ?? []).find((connector) => connector.id === granting) : undefined;
  const connectorOf = (appId: string) => (connectors ?? []).find((connector) => connector.appId === appId);
  const unusedRuntimes = (listing?.runtimes ?? []).filter((runtime) => runtime.usedBy.length === 0);

  const renderCard = (card: (typeof cards)[number]) => {
    const connector = connectorOf(card.entry.id);
    return <AppCardView key={card.entry.id} card={card} {...(connector ? { connector } : {})} stdioAllowed={listing?.stdioAllowed ?? true} onInstall={() => setInstalling(card.entry.id)} onGrant={(item) => setGranting(item.id)} onGrantSkill={(skill) => setGrantingSkillId(skill.id)} />;
  };

  return (
    <div className="lib-tab" data-testid="library-apps">
      <p className="app-intro">
        Projetos open source da comunidade, sugeridos por nós. <strong>Nenhum vem instalado</strong>: você instala só o que quiser, vê o plano antes, e o Cyno monta tudo numa pasta própria, registra o conector na Biblioteca e roda um teste para provar que funcionou. Depois é só liberar a quem for usar.
      </p>

      {listing && !listing.stdioAllowed && (
        <section className="app-warning" role="alert" data-testid="app-stdio-off">
          <strong>Os conectores locais estão desligados neste servidor</strong>
          <p>
            Os apps rodam como conectores locais (um comando nesta máquina), por isso a instalação fica bloqueada. Para ligar, reinicie o servidor com <code>CONNECTORS_STDIO=1</code> (por exemplo <code>CONNECTORS_STDIO=1 npm start</code>) e recarregue esta página. Só faça isso numa rede em que você confia.
          </p>
        </section>
      )}

      <ErrorText>{loadError}</ErrorText>
      {listing === null ? (
        !loadError && (
          <p className="ui-muted" role="status">
            Carregando o catálogo…
          </p>
        )
      ) : (
        <>
          <p className="app-count ui-muted" data-testid="app-count">
            {available.length} {available.length === 1 ? "app disponível" : "apps disponíveis"} · {installedCount} {installedCount === 1 ? "instalado" : "instalados"}
            {updates > 0 ? ` · ${updates} com atualização` : ""}
          </p>
          <ul className="lib-list" data-testid="app-list">
            {available.map(renderCard)}
          </ul>

          {soon.length > 0 && (
            <>
              <h3 className="app-section">Em breve</h3>
              <ul className="lib-list" data-testid="app-soon-list">
                {soon.map(renderCard)}
              </ul>
            </>
          )}

          <section className="app-runtimes" data-testid="app-runtimes" aria-label="Runtimes compartilhados">
            <h3 className="app-section">Runtimes compartilhados</h3>
            {listing.runtimes.length === 0 ? (
              <p className="ui-muted">Nenhum ainda. Os apps baixam o que precisam (como o uv, que instala o Python) para <code>data/platform/runtimes/</code>, sem tocar no sistema.</p>
            ) : (
              <ul className="app-runtimes__list">
                {listing.runtimes.map((runtime) => (
                  <li key={runtime.id} data-testid={`app-runtime-${runtime.id}`}>
                    <strong>{runtime.label}</strong>
                    <span className="ui-muted">
                      {" "}
                      · {formatBytes(runtime.sizeBytes)} · {runtime.usedBy.length > 0 ? `usado por ${runtime.usedBy.join(", ")}` : "ninguém usa"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {unusedRuntimes.length > 0 && (
              <div className="ui-actions">
                <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={clean.pending} onClick={() => void clean.run(async () => (await appsApi.cleanRuntimes(), useLibraryAppsStore.getState().load()))} data-testid="app-clean-runtimes">
                  {clean.pending ? "Limpando…" : "Limpar os que ninguém usa"}
                </button>
              </div>
            )}
            <ErrorText>{clean.error}</ErrorText>
          </section>
        </>
      )}

      {installing && <InstallDialog appId={installing} onClose={() => setInstalling(null)} />}
      {grantingConnector && <GrantDialog connector={grantingConnector} onClose={() => setGranting(null)} />}
      {grantingSkill && <GrantDialog skill={grantingSkill} onClose={() => setGrantingSkillId(null)} />}
    </div>
  );
}
