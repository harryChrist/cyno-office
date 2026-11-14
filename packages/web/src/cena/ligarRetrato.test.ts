import type { OfficeState } from "@cyno/shared";
import type { OfficeSnapshot } from "@cyno/cena";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentLogStore } from "../store/agentLogStore";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useTerminalsStore } from "../store/terminalsStore";
import { makeAgent, makeRoom } from "../test-fixtures";
import { ATRASO_DO_RETRATO_MS, chaveDaMemoria, ligarRetrato, type Armazenamento, type FontesDoRetrato, type LeituraDoCyno } from "./ligarRetrato";
import { fontesDoCyno } from "./fontesDoCyno";

vi.mock("../ui/EngineFields", () => ({ loadEngines: () => Promise.resolve([]) }));

const escritorio = (nomes: string[] = ["ana"]): OfficeState => ({
  rooms: [makeRoom("estudio", { name: "Estúdio" }), makeRoom("maestro", { kind: "maestro", name: "Sala do Maestro" })],
  teams: [
    { id: "gerencia", roomId: "maestro", name: "Gerência", focus: "" },
    { id: "texto", roomId: "estudio", name: "Texto", focus: "" },
  ],
  agents: [makeAgent("maestro-1", "gerencia"), ...nomes.map((id) => makeAgent(id, "texto"))],
  tasks: [],
});

function leitura(office: OfficeState): LeituraDoCyno {
  return { office, progress: {}, forYou: [], projects: [], terminals: {}, logs: {}, indisponiveis: {} };
}

function memoriaFalsa(): Armazenamento & { dados: Map<string, string> } {
  const dados = new Map<string, string>();
  return { dados, ler: (chave) => dados.get(chave) ?? null, gravar: (chave, valor) => void dados.set(chave, valor) };
}

describe("ligarRetrato (fontes falsas)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function montar(inicial: LeituraDoCyno | null) {
    let atual = inicial;
    const avisos = new Set<() => void>();
    const fontes: FontesDoRetrato = {
      ler: () => atual,
      assinar: (avisar) => {
        avisos.add(avisar);
        return () => avisos.delete(avisar);
      },
    };
    const publicados: OfficeSnapshot[] = [];
    const armazenamento = memoriaFalsa();
    const ligacao = ligarRetrato({ workspaceId: "ws", workspaceName: "WS", fontes, destino: { publicar: (r) => void publicados.push(r) }, armazenamento, agora: () => 1_000_000 });
    return {
      publicados,
      armazenamento,
      ligacao,
      avisos,
      mudar(proxima: LeituraDoCyno | null) {
        atual = proxima;
        for (const avisar of [...avisos]) avisar();
      },
    };
  }

  it("publica o primeiro retrato assim que o escritório carrega, sem esperar o atraso", () => {
    const t = montar(leitura(escritorio()));
    vi.advanceTimersByTime(0);
    expect(t.publicados).toHaveLength(1);
    expect(t.publicados[0]?.agents.map((a) => a.id)).toEqual(["maestro-1", "ana"]);
  });

  it("não publica nada enquanto o escritório não carregou, e publica quando carrega", () => {
    const t = montar(null);
    vi.advanceTimersByTime(1000);
    expect(t.publicados).toHaveLength(0);
    t.mudar(leitura(escritorio()));
    vi.advanceTimersByTime(0);
    expect(t.publicados).toHaveLength(1);
  });

  it("uma mudança vira um retrato novo; rajadas viram um só (com atraso)", () => {
    const t = montar(leitura(escritorio()));
    vi.advanceTimersByTime(0);
    t.mudar(leitura(escritorio(["ana", "bia"])));
    t.mudar(leitura(escritorio(["ana", "bia", "caio"])));
    expect(t.publicados).toHaveLength(1);
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS);
    expect(t.publicados).toHaveLength(2);
    expect(t.publicados[1]?.agents.map((a) => a.id)).toEqual(["maestro-1", "ana", "bia", "caio"]);
    expect(t.publicados[1]!.rev).toBeGreaterThan(t.publicados[0]!.rev);
  });

  it("nenhuma mudança (ou uma mudança que não altera o retrato) não gera retrato", () => {
    const t = montar(leitura(escritorio()));
    vi.advanceTimersByTime(0);
    t.mudar(leitura(escritorio()));
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS * 3);
    t.mudar({ ...leitura(escritorio()), progress: { fantasma: { agentId: "ninguem", progress: 0.5, message: "x" } } });
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS * 3);
    expect(t.publicados).toHaveLength(1);
  });

  it("guarda a ordem de chegada e a retoma na próxima ligação (recarga da página)", () => {
    const t = montar(leitura(escritorio()));
    vi.advanceTimersByTime(0);
    const guardado = t.armazenamento.dados.get(chaveDaMemoria("ws"));
    expect(guardado).toContain('"ana"');
    // nova "página" com a mesma memória: o horário de chegada de quem já existia não muda
    const publicados: OfficeSnapshot[] = [];
    const fontes: FontesDoRetrato = { ler: () => leitura(escritorio()), assinar: () => () => undefined };
    ligarRetrato({ workspaceId: "ws", workspaceName: "WS", fontes, destino: { publicar: (r) => void publicados.push(r) }, armazenamento: t.armazenamento, agora: () => 9_999_999 });
    vi.advanceTimersByTime(0);
    expect(publicados[0]?.agents.find((a) => a.id === "ana")?.startedAt).toBe(t.publicados[0]?.agents.find((a) => a.id === "ana")?.startedAt);
  });

  it("depois de desligar, nada mais é publicado nem assinado", () => {
    const t = montar(leitura(escritorio()));
    vi.advanceTimersByTime(0);
    t.ligacao.desligar();
    expect(t.avisos.size).toBe(0);
    t.mudar(leitura(escritorio(["ana", "bia"])));
    vi.advanceTimersByTime(1000);
    expect(t.publicados).toHaveLength(1);
  });
});

describe("fontesDoCyno (lojas Zustand reais)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNavStore.setState({ workspaceId: "ws" });
    useOfficeStore.setState({ office: escritorio() });
    useTerminalsStore.setState({ byAgent: {} });
    useAgentLogStore.setState({ byAgent: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    useOfficeStore.setState({ office: null });
  });

  function ligar() {
    const publicados: OfficeSnapshot[] = [];
    const ligacao = ligarRetrato({ workspaceId: "ws", workspaceName: "WS", fontes: fontesDoCyno("ws"), destino: { publicar: (r) => void publicados.push(r) }, armazenamento: memoriaFalsa(), agora: () => 5_000_000 });
    vi.advanceTimersByTime(0);
    return { publicados, ligacao };
  }

  it("uma mudança numa loja do Cyno vira um retrato novo", () => {
    const { publicados, ligacao } = ligar();
    expect(publicados).toHaveLength(1);
    useOfficeStore.setState({ office: escritorio(["ana", "bia"]) });
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS);
    expect(publicados).toHaveLength(2);
    expect(publicados[1]?.agents.map((a) => a.id)).toContain("bia");
    useTerminalsStore.setState({ byAgent: { ana: { agentId: "ana", engine: "claude", status: "error", error: "caiu", updatedAt: "2026-11-12T12:00:00.000Z" } } });
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS);
    expect(publicados).toHaveLength(2);
    ligacao.desligar();
  });

  it("nenhuma mudança não gera retrato (o mesmo estado regravado não monta nada)", () => {
    const { publicados, ligacao } = ligar();
    useOfficeStore.setState({ office: useOfficeStore.getState().office });
    useTerminalsStore.setState({ byAgent: useTerminalsStore.getState().byAgent });
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS * 4);
    expect(publicados).toHaveLength(1);
    ligacao.desligar();
  });

  it("com a troca de workspace em andamento (nav já mudou) nada do escritório antigo é publicado", () => {
    const { publicados, ligacao } = ligar();
    useNavStore.setState({ workspaceId: "outro" });
    useOfficeStore.setState({ office: escritorio(["ana", "zeca"]) });
    vi.advanceTimersByTime(ATRASO_DO_RETRATO_MS * 2);
    expect(publicados).toHaveLength(1);
    ligacao.desligar();
  });
});
