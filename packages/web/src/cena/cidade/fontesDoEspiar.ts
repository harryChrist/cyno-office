// A fonte do retrato para "Espiar": o escritório de OUTRO workspace, só para olhar. Abre um socket próprio desse
// workspace (o `office:snapshot` traz tudo: escritório, progresso, terminais, projetos e o "Para você") e aplica os
// eventos com os mesmos reducers puros do app, mas em estado local: nenhuma loja global é tocada, então o workspace
// aberto (navStore) e a tela dele não mudam. O socket fecha quando a assinatura é desfeita (ao fechar a janela).
import { expandAvulsas, type AgentTerminalInfo, type Project, type ServerEvent } from "@cyno/shared";
import { applyTerminalEvent } from "../../store/terminalsStore";
import { INITIAL_SYNC, officeReducer, type OfficeSync } from "../../store/officeReducer";
import { connectOfficeSocket, type OfficeSocketHandlers } from "../../ws/officeSocket";
import type { FontesDoRetrato, LeituraDoCyno } from "../ligarRetrato";

/** O socket (a função real do app; os testes injetam uma falsa). */
export type Conectar = (opcoes: OfficeSocketHandlers) => () => void;

/** O estado "ao vivo" do outro workspace conforme os eventos chegam. */
export interface EstadoDoEspiar {
  sync: OfficeSync;
  terminais: Record<string, AgentTerminalInfo>;
  projetos: readonly Project[];
}

export const ESTADO_INICIAL: EstadoDoEspiar = { sync: INITIAL_SYNC, terminais: {}, projetos: [] };

/** Aplica um evento do servidor ao estado local (puro; devolve o mesmo objeto se nada mudou). */
export function aplicarEvento(estado: EstadoDoEspiar, evento: ServerEvent): EstadoDoEspiar {
  const sync = officeReducer(estado.sync, evento);
  const terminais = applyTerminalEvent(estado.terminais, evento);
  let projetos = estado.projetos;
  if (evento.type === "office:snapshot" && evento.projects) projetos = expandAvulsas(evento.projects);
  else if (evento.type === "project:deleted") projetos = estado.projetos.filter((p) => p.id !== evento.id);
  else if (evento.type === "project:upserted") {
    const existe = estado.projetos.some((p) => p.id === evento.project.id);
    projetos = expandAvulsas(existe ? estado.projetos.map((p) => (p.id === evento.project.id ? evento.project : p)) : [...estado.projetos, evento.project]);
  }
  if (sync === estado.sync && terminais === estado.terminais && projetos === estado.projetos) return estado;
  return { sync, terminais, projetos };
}

/** A leitura que o adaptador `montarRetrato` espera, a partir do estado local (null até o primeiro snapshot). */
export function leituraDoEstado(estado: EstadoDoEspiar): LeituraDoCyno | null {
  const { office, progress, forYou } = estado.sync;
  if (!office) return null;
  return { office, progress, forYou, projects: estado.projetos, terminals: estado.terminais, logs: {}, indisponiveis: {} };
}

/** Relógio que refaz a leitura para o que depende só da hora (estados com tempo). */
export const RELOGIO_DO_ESPIAR_MS = 30_000;

export function fontesDoEspiar(workspaceId: string, conectar: Conectar = connectOfficeSocket): FontesDoRetrato {
  let estado = ESTADO_INICIAL;
  return {
    ler: () => leituraDoEstado(estado),
    assinar(avisar) {
      estado = ESTADO_INICIAL;
      const fechar = conectar({
        workspaceId,
        onEvent: (evento) => {
          const novo = aplicarEvento(estado, evento);
          if (novo === estado) return;
          estado = novo;
          avisar();
        },
      });
      const relogio = setInterval(avisar, RELOGIO_DO_ESPIAR_MS);
      return () => {
        clearInterval(relogio);
        fechar();
      };
    },
  };
}
