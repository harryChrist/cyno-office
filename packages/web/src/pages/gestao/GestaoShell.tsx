import { useNavStore } from "../../store/navStore";
import { PAGE_HINTS } from "../../hud/nav/navItemsView";
import { ActivityPage } from "../activity/ActivityPage";
import { PageTabs } from "../PageTabs";
import { SpendPage } from "../spend/SpendPage";
import { GestaoPage } from "./GestaoPage";
import { PessoasTab } from "./PessoasTab";
import { PainelTab } from "./painel/PainelTab";
import { RelatoriosTab } from "./relatorios/RelatoriosTab";
import { GESTAO_TABS, gestaoTabEnabled, gestaoTabFromSub } from "./gestaoTabs";

/**
 * A Gestão com abas: Painel (a semana e o dia), Rotinas e metas, Pessoas, Gastos, Atividade e Relatórios. Gastos e Atividade são as
 * páginas de antes, montadas aqui dentro; cada aba tem o seu endereço (`#/<ws>/gestao/gastos`). O título
 * é um só (o "Gestão" daqui): o título de cada página montada dentro da aba fica só para leitores de tela.
 */
export function GestaoShell() {
  const sub = useNavStore((state) => state.sub);
  const workspaceId = useNavStore((state) => state.workspaceId);
  const go = useNavStore((state) => state.go);
  const tab = gestaoTabFromSub(sub);
  const tabs = GESTAO_TABS.map((item) => ({ id: item.id, label: item.label, disabled: !gestaoTabEnabled(item.id, workspaceId !== null) }));
  return (
    <div className="gshell" data-testid="gestao-shell">
      <header className="gshell__head">
        <h2 className="page__title" id="page-title-gestao-shell">
          Gestão
        </h2>
        <p className="page__subtitle">{PAGE_HINTS.gestao}</p>
      </header>
      <PageTabs label="Seções da Gestão" tabs={tabs} active={tab} onSelect={(id) => go("gestao", GESTAO_TABS.find((item) => item.id === id)!.sub)} testIdPrefix="gestao-tab" />
      <div className="gshell__body">
        {tab === "painel" && <PainelTab />}
        {tab === "visao-geral" && <GestaoPage />}
        {tab === "pessoas" && <PessoasTab />}
        {tab === "gastos" && <SpendPage />}
        {tab === "atividade" && <ActivityPage />}
        {tab === "relatorios" && <RelatoriosTab />}
      </div>
    </div>
  );
}
