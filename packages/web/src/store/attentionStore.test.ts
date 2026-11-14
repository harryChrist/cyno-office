import { DEFAULT_ATTENTION_PREFS, attentionTitle, type AttentionAlert } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attention = vi.fn();
const attentionPrefs = vi.fn();
const attentionSeen = vi.fn();
vi.mock("../api/client", () => ({ api: { attention: (...a: unknown[]) => attention(...a), attentionPrefs: (...a: unknown[]) => attentionPrefs(...a), attentionSeen: (...a: unknown[]) => attentionSeen(...a), saveAttentionPrefs: vi.fn() } }));

const { onAttentionRaised, selectOwnerCount, upsertAlert, useAttentionStore } = await import("./attentionStore");
const { agentAttentionOf } = await import("../attention/agents");

const al = (key: string, at: string, change: Partial<AttentionAlert> = {}): AttentionAlert => ({
  id: `id-${key}`,
  key,
  kind: "approval",
  level: "alert",
  needsOwner: true,
  workspaceId: "ws",
  agentId: "eco",
  text: key,
  count: 1,
  at,
  updatedAt: at,
  target: { page: "para-voce", workspaceId: "ws", ref: key },
  ...change,
});

beforeEach(() => {
  attention.mockReset();
  attentionPrefs.mockReset();
  attentionSeen.mockReset();
  useAttentionStore.setState({ open: [], prefs: structuredClone(DEFAULT_ATTENTION_PREFS), loaded: false, tour: null });
});

describe("attentionStore", () => {
  it("o alerta que nasce ao vivo avisa os ouvintes uma vez; o replay, o que já estava e a carga inicial não", async () => {
    const heard: string[] = [];
    const off = onAttentionRaised((alert) => heard.push(alert.key));
    const store = useAttentionStore.getState();
    store.applyEvent({ type: "attention:raised", alert: al("a", "2026-11-12T10:00:00Z") });
    store.applyEvent({ type: "attention:raised", alert: al("a", "2026-11-12T10:00:00Z") });
    store.applyEvent({ type: "attention:raised", alert: al("b", "2026-11-12T10:00:00Z", { replay: true }) });
    attention.mockResolvedValue({ open: [al("c", "2026-11-12T09:00:00Z")], serverTime: "2026-11-12T12:00:00Z" });
    attentionPrefs.mockResolvedValue(DEFAULT_ATTENTION_PREFS);
    await store.load();
    off();
    expect(heard).toEqual(["a"]);
    // A carga traz a lista inteira do servidor (a verdade do instante).
    expect(useAttentionStore.getState().open.map((alert) => alert.key)).toEqual(["c"]);
    expect(useAttentionStore.getState().loaded).toBe(true);
  });

  it("updated troca o alerta (nunca por uma versão mais velha); cleared tira e zera o percurso", () => {
    const store = useAttentionStore.getState();
    store.applyEvent({ type: "attention:raised", alert: al("a", "2026-11-12T10:00:00Z") });
    store.applyEvent({ type: "attention:updated", alert: { ...al("a", "2026-11-12T10:00:00Z"), count: 3, updatedAt: "2026-11-12T10:05:00Z" } });
    expect(useAttentionStore.getState().open[0]!.count).toBe(3);
    store.applyEvent({ type: "attention:updated", alert: { ...al("a", "2026-11-12T10:00:00Z"), count: 1, updatedAt: "2026-11-12T10:01:00Z" } });
    expect(useAttentionStore.getState().open[0]!.count).toBe(3);
    useAttentionStore.setState({ tour: "a" });
    store.applyEvent({ type: "attention:cleared", key: "a", reason: "decided" });
    expect(useAttentionStore.getState()).toMatchObject({ open: [], tour: null });
  });

  it("o percurso do contador: do mais antigo ao mais novo, dando a volta; Shift volta", () => {
    const store = useAttentionStore.getState();
    store.applyEvent({ type: "attention:raised", alert: al("novo", "2026-11-12T12:00:00Z") });
    store.applyEvent({ type: "attention:raised", alert: al("velho", "2026-11-12T08:00:00Z") });
    store.applyEvent({ type: "attention:raised", alert: al("meio", "2026-11-12T10:00:00Z") });
    store.applyEvent({ type: "attention:raised", alert: al("falha", "2026-11-12T07:00:00Z", { kind: "failed", level: "warn", needsOwner: false }) });
    const order = [1, 2, 3, 4].map(() => useAttentionStore.getState().step(1)?.key);
    expect(order).toEqual(["velho", "meio", "novo", "velho"]);
    expect(useAttentionStore.getState().step(-1)?.key).toBe("novo");
  });

  it("o número é só o que espera o dono; o título acompanha", () => {
    const store = useAttentionStore.getState();
    store.applyEvent({ type: "attention:raised", alert: al("a", "2026-11-12T10:00:00Z") });
    store.applyEvent({ type: "attention:raised", alert: al("b", "2026-11-12T10:00:00Z", { needsOwner: false, kind: "usage", level: "warn" }) });
    store.applyEvent({ type: "attention:raised", alert: al("c", "2026-11-12T10:00:00Z", { replay: true }) });
    const count = selectOwnerCount(useAttentionStore.getState());
    expect(count).toBe(2);
    expect(attentionTitle(count)).toBe("(2) Cyno");
    store.applyEvent({ type: "attention:cleared", key: "a", reason: "decided" });
    store.applyEvent({ type: "attention:cleared", key: "c", reason: "decided" });
    expect(attentionTitle(selectOwnerCount(useAttentionStore.getState()))).toBe("Cyno");
  });

  it("o número e o título somam os itens: um lote de 5 aprovações conta 5, mas o percurso continua por alerta", () => {
    const store = useAttentionStore.getState();
    store.applyEvent({ type: "attention:raised", alert: al("lote", "2026-11-12T10:00:00Z", { count: 5 }) });
    expect(selectOwnerCount(useAttentionStore.getState())).toBe(5);
    store.applyEvent({ type: "attention:raised", alert: al("ajuda", "2026-11-12T10:05:00Z", { kind: "help" }) });
    const count = selectOwnerCount(useAttentionStore.getState());
    expect(count).toBe(6);
    expect(attentionTitle(count)).toBe("(6) Cyno");
    expect(store.step()?.key).toBe("lote");
  });

  it("\"Visto\" tira na hora e chama a rota; sem nada esperando o percurso devolve undefined", async () => {
    const store = useAttentionStore.getState();
    store.applyEvent({ type: "attention:raised", alert: al("f", "2026-11-12T10:00:00Z", { kind: "failed", level: "warn", needsOwner: false }) });
    attentionSeen.mockResolvedValue(undefined);
    await store.markSeen("f");
    expect(attentionSeen).toHaveBeenCalledWith("f");
    expect(useAttentionStore.getState().open).toEqual([]);
    expect(store.step()).toBeUndefined();
  });

  it("upsertAlert mantém a lista em ordem de hora", () => {
    const list = upsertAlert(upsertAlert([], al("b", "2026-11-12T11:00:00Z")), al("a", "2026-11-12T09:00:00Z"));
    expect(list.map((alert) => alert.key)).toEqual(["a", "b"]);
  });
});

describe("agentesQuePedemAtencao (o encaixe da cena)", () => {
  it("só os alertas que esperam o dono e têm agente; o mais antigo manda; limita ao workspace", () => {
    const open = [
      al("1", "2026-11-12T10:00:00Z", { agentId: "eco" }),
      al("2", "2026-11-12T09:00:00Z", { agentId: "eco", kind: "question" }),
      al("3", "2026-11-12T09:30:00Z", { agentId: "crivo", workspaceId: "outro" }),
      al("4", "2026-11-12T09:30:00Z", { agentId: "radar", needsOwner: false, kind: "failed", level: "warn" }),
      al("5", "2026-11-12T09:30:00Z", { agentId: undefined, kind: "usage", needsOwner: false, level: "warn" }),
    ];
    const all = agentAttentionOf(open);
    expect([...all.keys()].sort()).toEqual(["crivo", "eco"]);
    expect(all.get("eco")).toEqual({ kind: "question", since: "2026-11-12T09:00:00Z", count: 2 });
    expect([...agentAttentionOf(open, "ws").keys()]).toEqual(["eco"]);
  });
});
