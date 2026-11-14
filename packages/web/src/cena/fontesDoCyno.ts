// As lojas Zustand do Cyno como fonte do retrato (`FontesDoRetrato`): lê o que o adaptador precisa e avisa só
// quando uma das fatias que ele usa mudou (as lojas devolvem o mesmo objeto quando nada muda).
import type { EngineInfo } from "@cyno/shared";
import { agentAttentionOf } from "../attention/agents";
import { useAttentionStore } from "../store/attentionStore";
import { useGoalHitsStore } from "../store/goalHitsStore";
import { useAgentLogStore } from "../store/agentLogStore";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useTerminalsStore } from "../store/terminalsStore";
import { useUsageStore } from "../store/usageStore";
import { useWorkStore } from "../store/workStore";
import { availabilityByAgent } from "../ui/availability";
import { loadEngines } from "../ui/EngineFields";
import type { FontesDoRetrato, LeituraDoCyno } from "./ligarRetrato";

/** A cota que volta passa sem evento nenhum: de tempos em tempos a leitura é refeita (o retrato só sai se mudou). */
export const RELOGIO_DAS_FONTES_MS = 30_000;

export function fontesDoCyno(workspaceId: string): FontesDoRetrato {
  let motores: readonly EngineInfo[] | undefined;
  let pediuMotores = false;

  return {
    ler(): LeituraDoCyno | null {
      // Troca de workspace em andamento: o escritório que está na loja ainda pode ser o anterior.
      if (useNavStore.getState().workspaceId !== workspaceId) return null;
      const { office, progress, forYou } = useOfficeStore.getState();
      if (!office) return null;
      const indisponiveis = availabilityByAgent(office.agents, useUsageStore.getState().byProvider, motores, Date.now());
      return {
        office,
        progress,
        forYou,
        projects: useWorkStore.getState().projects,
        terminals: useTerminalsStore.getState().byAgent,
        logs: useAgentLogStore.getState().byAgent,
        indisponiveis,
        metasBatidas: useGoalHitsStore.getState().hits,
        atencao: agentAttentionOf(useAttentionStore.getState().open, workspaceId),
      };
    },

    assinar(avisar) {
      const desfazer: Array<() => void> = [];
      let office = useOfficeStore.getState().office;
      let progress = useOfficeStore.getState().progress;
      let forYou = useOfficeStore.getState().forYou;
      desfazer.push(
        useOfficeStore.subscribe((estado) => {
          if (estado.office === office && estado.progress === progress && estado.forYou === forYou) return;
          office = estado.office;
          progress = estado.progress;
          forYou = estado.forYou;
          avisar();
        }),
      );
      let logs = useAgentLogStore.getState().byAgent;
      desfazer.push(
        useAgentLogStore.subscribe((estado) => {
          if (estado.byAgent === logs) return;
          logs = estado.byAgent;
          avisar();
        }),
      );
      let terminais = useTerminalsStore.getState().byAgent;
      desfazer.push(
        useTerminalsStore.subscribe((estado) => {
          if (estado.byAgent === terminais) return;
          terminais = estado.byAgent;
          avisar();
        }),
      );
      let projetos = useWorkStore.getState().projects;
      desfazer.push(
        useWorkStore.subscribe((estado) => {
          if (estado.projects === projetos) return;
          projetos = estado.projects;
          avisar();
        }),
      );
      let uso = useUsageStore.getState().byProvider;
      desfazer.push(
        useUsageStore.subscribe((estado) => {
          if (estado.byProvider === uso) return;
          uso = estado.byProvider;
          avisar();
        }),
      );
      let metas = useGoalHitsStore.getState().hits;
      desfazer.push(
        useGoalHitsStore.subscribe((estado) => {
          if (estado.hits === metas) return;
          metas = estado.hits;
          avisar();
        }),
      );
      let alertas = useAttentionStore.getState().open;
      desfazer.push(
        useAttentionStore.subscribe((estado) => {
          if (estado.open === alertas) return;
          alertas = estado.open;
          avisar();
        }),
      );
      // Troca de workspace: o `nav` muda antes de o escritório novo chegar.
      let navegado = useNavStore.getState().workspaceId;
      desfazer.push(
        useNavStore.subscribe((estado) => {
          if (estado.workspaceId === navegado) return;
          navegado = estado.workspaceId;
          avisar();
        }),
      );
      if (!pediuMotores) {
        pediuMotores = true;
        loadEngines().then(
          (lista) => {
            motores = lista;
            avisar();
          },
          () => undefined,
        );
      }
      const relogio = setInterval(avisar, RELOGIO_DAS_FONTES_MS);
      return () => {
        clearInterval(relogio);
        for (const f of desfazer) f();
      };
    },
  };
}
