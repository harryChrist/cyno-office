import { useEffect } from "react";
import { useNavStore } from "../../store/navStore";
import { useVersionStore, watchVersion } from "../../store/versionStore";
import { navTone, navVersionView, type NavTone, type NavVersionView as NavVersionViewModel } from "../../version/versionView";
import "../../version/version.css";

/** O destaque da versão (atualização disponível ou reinício pendente) para o ponto no botão de menu do celular. */
export function useVersionTone(): NavTone {
  useEffect(() => watchVersion(), []);
  return useVersionStore((state) => navTone(state.data));
}

/**
 * A versão do app como etiqueta pequena na linha da marca (barra lateral e gaveta do celular): `v0.1.0`, discreta, sem
 * ocupar linha própria. Com atualização no GitHub vira "Atualizar" com ponto violeta; com o código novo já baixado,
 * "Reinicie" com ponto âmbar (que ganha da outra). O texto completo vai na dica e no nome do botão. Clicar abre
 * Configurações > Versão e atualizações. Recolhida, a etiqueta some e, havendo novidade, fica só o ponto no canto do logo.
 */
export function NavVersion({ onNavigate }: { onNavigate?: () => void }) {
  const data = useVersionStore((state) => state.data);
  const go = useNavStore((state) => state.go);
  const open = useNavStore((state) => state.page === "configuracoes" && state.sub === "versao");
  useEffect(() => watchVersion(), []);
  return (
    <NavVersionView
      view={navVersionView(data)}
      open={open}
      onOpen={() => {
        go("configuracoes", "versao");
        onNavigate?.();
      }}
    />
  );
}

/** O botão em si, a partir do que a tela mostra (separado do NavVersion para dar para testar sem as lojas). */
export function NavVersionView({ view, open, onOpen }: { view: NavVersionViewModel | null; open: boolean; onOpen: () => void }) {
  if (!view) return null;
  return (
    <button
      type="button"
      className={`navversion${view.tone === "update" ? " navversion--update" : view.tone === "restart" ? " navversion--update navversion--restart" : ""}`}
      aria-label={view.aria}
      aria-current={open ? "page" : undefined}
      title={view.tip}
      data-tip={view.text}
      data-tip-hint={view.sub ?? undefined}
      onClick={onOpen}
      data-testid="nav-version"
    >
      {view.tone !== "normal" && <span className="navversion__dot" aria-hidden="true" data-testid="nav-version-dot" />}
      <span className="navversion__text" data-testid="nav-version-text">
        {view.chip}
      </span>
    </button>
  );
}
