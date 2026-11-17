import { BrowserPage } from "../browser/BrowserPage";
import { useNavStore } from "../store/navStore";
import { CynoPage } from "./cyno/CynoPage";
import { AgendaPage } from "./agenda/AgendaPage";
import { ForYouPage } from "./foryou/ForYouPage";
import { GestaoShell } from "./gestao/GestaoShell";
import { LibraryPage } from "./library/LibraryPage";
import { QuadroPage } from "./quadro/QuadroPage";
import "./pages.css";
import { SettingsPage } from "./settings/SettingsPage";
import { WorkPage } from "./work/WorkPage";

/** As páginas fora do Office cobrem o escritório (que fica pausado embaixo). */
export function Pages() {
  const page = useNavStore((state) => state.page);
  if (page === "office") return null;
  return (
    <main className="pages" data-testid="pages">
      {page === "trabalho" && <WorkPage />}
      {page === "para-voce" && <ForYouPage />}
      {page === "quadro" && <QuadroPage />}
      {page === "gestao" && <GestaoShell />}
      {/* `#/agenda` é a agenda inteira; `#/agenda/<ws>` já vem filtrada nele. */}
      {page === "agenda" && <AgendaPage />}
      {page === "navegador" && <BrowserPage />}
      {page === "configuracoes" && <SettingsPage />}
      {page === "cyno" && <CynoPage />}
      {page === "biblioteca" && <LibraryPage />}
    </main>
  );
}
