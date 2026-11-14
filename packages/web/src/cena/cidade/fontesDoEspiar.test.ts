import type { AgentTerminalInfo, OfficeState, ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useTerminalsStore } from "../../store/terminalsStore";
import type { OfficeSocketHandlers } from "../../ws/officeSocket";
import { aplicarEvento, ESTADO_INICIAL, fontesDoEspiar, leituraDoEstado } from "./fontesDoEspiar";

const escritorio = (agentes: string[]): OfficeState =>
  ({ rooms: [{ id: "r1", name: "Sala", readsBrainsOf: [] }], teams: [{ id: "t1", roomId: "r1", name: "Time" }], agents: agentes.map((id) => ({ id, teamId: "t1", name: id })), tasks: [] }) as unknown as OfficeState;
const snapshot = (agentes: string[], extra: Partial<Extract<ServerEvent, { type: "office:snapshot" }>> = {}): ServerEvent => ({ type: "office:snapshot", office: escritorio(agentes), ...extra }) as ServerEvent;
const terminal = (agentId: string, status: AgentTerminalInfo["status"]): AgentTerminalInfo => ({ agentId, status }) as AgentTerminalInfo;

afterEach(() => {
  vi.useRealTimers();
});

describe("o estado local do espiar", () => {
  it("antes do snapshot não há leitura", () => {
    expect(leituraDoEstado(ESTADO_INICIAL)).toBeNull();
  });

  it("o snapshot traz escritório, terminais e projetos", () => {
    const estado = aplicarEvento(ESTADO_INICIAL, snapshot(["a1"], { terminals: { a1: terminal("a1", "busy") }, projects: [] }));
    const leitura = leituraDoEstado(estado)!;
    expect(leitura.office.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(leitura.terminals.a1?.status).toBe("busy");
    expect(leitura.projects).toEqual([]);
  });

  it("o terminal muda com o evento do agente", () => {
    let estado = aplicarEvento(ESTADO_INICIAL, snapshot(["a1"]));
    estado = aplicarEvento(estado, { type: "agent:terminal", terminal: terminal("a1", "busy") });
    expect(leituraDoEstado(estado)!.terminals.a1?.status).toBe("busy");
    estado = aplicarEvento(estado, { type: "agent:terminal", terminal: terminal("a1", "idle") });
    expect(leituraDoEstado(estado)!.terminals.a1?.status).toBe("idle");
  });

  it("um evento que não interessa devolve o mesmo estado", () => {
    const estado = aplicarEvento(ESTADO_INICIAL, snapshot(["a1"]));
    expect(aplicarEvento(estado, { type: "sync:resumed", epoch: "e", since: 1 } as ServerEvent)).toBe(estado);
  });
});

describe("espiar um workspace sem mexer no aberto", () => {
  it("abre o socket do OUTRO workspace, avisa a cada evento e fecha ao desassinar", () => {
    let manipuladores: OfficeSocketHandlers | null = null;
    const fechar = vi.fn();
    const fontes = fontesDoEspiar("outro", (opcoes) => {
      manipuladores = opcoes;
      return fechar;
    });
    const avisar = vi.fn();
    const desfazer = fontes.assinar(avisar);
    expect(manipuladores).not.toBeNull();
    expect((manipuladores as unknown as OfficeSocketHandlers).workspaceId).toBe("outro");
    expect(fontes.ler()).toBeNull();
    (manipuladores as unknown as OfficeSocketHandlers).onEvent(snapshot(["a1", "a2"]));
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(fontes.ler()!.office.agents).toHaveLength(2);
    desfazer();
    expect(fechar).toHaveBeenCalledTimes(1);
  });

  it("as lojas globais do app (workspace aberto, escritório, terminais) não são tocadas", () => {
    useNavStore.setState({ workspaceId: "aberto" });
    const officeAntes = useOfficeStore.getState().office;
    const terminaisAntes = useTerminalsStore.getState().byAgent;
    let manipuladores: OfficeSocketHandlers | null = null;
    const fontes = fontesDoEspiar("outro", (opcoes) => {
      manipuladores = opcoes;
      return () => undefined;
    });
    const desfazer = fontes.assinar(() => undefined);
    const m = manipuladores as unknown as OfficeSocketHandlers;
    m.onEvent(snapshot(["x"], { terminals: { x: terminal("x", "busy") } }));
    m.onEvent({ type: "agent:terminal", terminal: terminal("x", "idle") });
    expect(useNavStore.getState().workspaceId).toBe("aberto");
    expect(useOfficeStore.getState().office).toBe(officeAntes);
    expect(useTerminalsStore.getState().byAgent).toBe(terminaisAntes);
    desfazer();
  });

  it("o relógio refaz a leitura e para ao fechar", () => {
    vi.useFakeTimers();
    const fontes = fontesDoEspiar("outro", () => () => undefined);
    const avisar = vi.fn();
    const desfazer = fontes.assinar(avisar);
    vi.advanceTimersByTime(30_000);
    expect(avisar).toHaveBeenCalledTimes(1);
    desfazer();
    vi.advanceTimersByTime(60_000);
    expect(avisar).toHaveBeenCalledTimes(1);
  });
});
