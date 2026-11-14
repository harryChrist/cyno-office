import { useNavStore } from "../../store/navStore";
import { PageTabs } from "../PageTabs";
import { workSub } from "./workRoute";

const TABS = [
  { id: "projetos", label: "Projetos" },
  { id: "tarefas", label: "Todas as tarefas" },
] as const;

/** As duas abas da entrada de "Projetos e tarefas": Projetos e Todas as tarefas (cada uma com endereço próprio). */
export function WorkTabs({ active }: { active: "projetos" | "tarefas" }) {
  const go = (to: "projetos" | "tarefas") => {
    if (to === active) return;
    useNavStore.getState().go("trabalho", to === "projetos" ? "" : workSub({ view: "tasks", query: "" }));
  };
  return <PageTabs flush className="wt-tabs" label="Projetos e tarefas" tabs={TABS} active={active} onSelect={go} testIdPrefix="work-tab" />;
}
