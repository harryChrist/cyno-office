import { agentAddress, isMaestroAgent, parseAddress, type RoutineModeBody } from "@cyno/shared";
import { useCallback, useMemo, useState } from "react";
import { api, describeError } from "../../api/client";
import { useRoutinesStore } from "../../store/routinesStore";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";

type Option = { value: string; label: string };

/** Donos possíveis de uma rotina: os times do escritório e os agentes (menos o Maestro). */
export function useOwnerOptions(): Option[] {
  const office = useOfficeStore((state) => state.office);
  return useMemo(() => {
    if (!office) return [];
    const teams = office.teams.map((team) => ({ value: `team:${team.id}`, label: `Time ${team.name}` }));
    const agents = office.agents.filter((agent) => !isMaestroAgent(office, agent)).map((agent) => ({ value: `agent:${agent.id}`, label: agent.name }));
    return [...teams, ...agents];
  }, [office]);
}

/** Agentes que podem ter um horário próprio: valor = endereço "workspace/agente". */
export function useAgentAddressOptions(): Option[] {
  const office = useOfficeStore((state) => state.office);
  const workspaceId = useNavStore((state) => state.workspaceId);
  return useMemo(() => {
    if (!office || !workspaceId) return [];
    return office.agents.filter((agent) => !isMaestroAgent(office, agent)).map((agent) => ({ value: agentAddress(workspaceId, agent.id), label: agent.name }));
  }, [office, workspaceId]);
}

/** Nome do agente de um endereço ("linkedin/eco" → "ECO"); sem cadastro, o próprio id. */
export function useAgentName(): (address: string) => string {
  const office = useOfficeStore((state) => state.office);
  return useCallback(
    (address: string) => {
      const id = parseAddress(address)?.agentId ?? address;
      return office?.agents.find((agent) => agent.id === id)?.name ?? id;
    },
    [office],
  );
}

/** Manda uma mudança de modo da rotina e guarda o estado (pendente, erro, inclusive o 409); depois recarrega as rotinas. */
export function useRoutineModeRequest(routineId: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useCallback(
    async (body: RoutineModeBody): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        await api.setRoutineMode(routineId, body);
        await useRoutinesStore.getState().load();
        return true;
      } catch (caught) {
        setError(describeError(caught));
        return false;
      } finally {
        setPending(false);
      }
    },
    [routineId],
  );
  return { pending, error, send };
}
