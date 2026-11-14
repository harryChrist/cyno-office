import type { AttentionAlert } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { addToast, dismissToast, expireToasts, pauseToast, pruneToasts, resumeToast, toastView, TOAST_JOIN_MS, TOAST_MAX, TOAST_RESUME_MIN_MS, type Toast } from "./toasts";

const NOW = 1_000_000;
const al = (key: string, change: Partial<AttentionAlert> = {}): AttentionAlert => ({
  id: `id-${key}`,
  key,
  kind: "approval",
  level: "alert",
  needsOwner: true,
  agentName: "Eco",
  workspaceName: "Meu Workspace",
  text: `Texto ${key}`,
  count: 1,
  at: "2026-11-12T12:00:00.000Z",
  updatedAt: "2026-11-12T12:00:00.000Z",
  target: { page: "para-voce" },
  ...change,
});

describe("a pilha de avisos", () => {
  it("um alerta de nível alert fica até a causa sumir; warn e info têm vida", () => {
    expect(addToast([], al("a"), NOW, "t1")[0]).toMatchObject({ keys: ["a"], expiresAt: null });
    expect(addToast([], al("a", { level: "warn" }), NOW, "t1")[0]!.expiresAt).toBe(NOW + 9_000);
    expect(addToast([], al("a", { level: "info" }), NOW, "t1")[0]!.expiresAt).toBe(NOW + 5_000);
  });

  it("o mesmo alerta duas vezes não abre outro aviso", () => {
    const first = addToast([], al("a"), NOW, "t1");
    expect(addToast(first, al("a"), NOW + 60_000, "t2")).toHaveLength(1);
  });

  it("vários alertas juntos (dentro de 6 s) viram um aviso só; depois disso, outro aviso", () => {
    let toasts = addToast([], al("a"), NOW, "t1");
    toasts = addToast(toasts, al("b"), NOW + 2_000, "t2");
    toasts = addToast(toasts, al("c"), NOW + 3_000, "t3");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.keys).toEqual(["a", "b", "c"]);
    toasts = addToast(toasts, al("d"), NOW + 3_000 + TOAST_JOIN_MS + 1, "t4");
    expect(toasts).toHaveLength(2);
  });

  it("juntar um alerta forte num aviso fraco o torna forte (fica até a causa sumir)", () => {
    let toasts = addToast([], al("a", { level: "warn" }), NOW, "t1");
    toasts = addToast(toasts, al("b"), NOW + 1_000, "t2");
    expect(toasts[0]).toMatchObject({ level: "alert", expiresAt: null });
  });

  it("no máximo 4: ao passar, sai o primeiro que não é alerta; se só há alertas, o mais antigo", () => {
    let toasts: Toast[] = [];
    const t = (i: number) => NOW + i * (TOAST_JOIN_MS + 1_000);
    toasts = addToast(toasts, al("a"), t(0), "t0");
    toasts = addToast(toasts, al("b", { level: "warn" }), t(1), "t1");
    toasts = addToast(toasts, al("c"), t(2), "t2");
    toasts = addToast(toasts, al("d"), t(3), "t3");
    expect(toasts).toHaveLength(TOAST_MAX);
    toasts = addToast(toasts, al("e"), t(4), "t4");
    expect(toasts.map((toast) => toast.keys[0])).toEqual(["a", "c", "d", "e"]);
    toasts = addToast(toasts, al("f"), t(5), "t5");
    expect(toasts.map((toast) => toast.keys[0])).toEqual(["c", "d", "e", "f"]);
  });

  it("a causa que sumiu tira o alerta do aviso; sem alerta, o aviso some", () => {
    let toasts = addToast([], al("a"), NOW, "t1");
    toasts = addToast(toasts, al("b"), NOW + 1_000, "t2");
    toasts = pruneToasts(toasts, new Map([["b", al("b")]]), NOW + 2_000);
    expect(toasts[0]!.keys).toEqual(["b"]);
    expect(pruneToasts(toasts, new Map(), NOW + 3_000)).toEqual([]);
  });

  it("o aviso que juntou uma aprovação e uma falha vira só o aviso da falha (e some sozinho) quando a aprovação sai", () => {
    const failed = al("f", { kind: "failed", level: "warn", needsOwner: false });
    let toasts = addToast([], al("a"), NOW, "t1");
    toasts = addToast(toasts, failed, NOW + 1_000, "t2");
    expect(toasts[0]).toMatchObject({ level: "alert", expiresAt: null });
    toasts = pruneToasts(toasts, new Map([["f", failed]]), NOW + 5_000);
    expect(toasts[0]).toMatchObject({ keys: ["f"], level: "warn", expiresAt: NOW + 5_000 + 9_000 });
    expect(expireToasts(toasts, NOW + 14_001)).toEqual([]);
  });

  it("a vida acaba sozinha; o mouse em cima pausa e, ao sair, volta com no mínimo 1,5 s", () => {
    let toasts = addToast([], al("a", { level: "warn" }), NOW, "t1");
    expect(expireToasts(toasts, NOW + 8_999)).toHaveLength(1);
    expect(expireToasts(toasts, NOW + 9_000)).toHaveLength(0);
    toasts = pauseToast(toasts, "t1", NOW + 8_500);
    expect(expireToasts(toasts, NOW + 60_000)).toHaveLength(1);
    toasts = resumeToast(toasts, "t1", NOW + 60_000);
    expect(toasts[0]!.expiresAt).toBe(NOW + 60_000 + TOAST_RESUME_MIN_MS);
    // Alerta (sem vida) nunca expira, nem pausado.
    const forever = addToast([], al("x"), NOW, "t9");
    expect(expireToasts(forever, NOW + 10_000_000)).toHaveLength(1);
  });

  it("fechar tira o aviso", () => {
    expect(dismissToast(addToast([], al("a"), NOW, "t1"), "t1")).toEqual([]);
  });
});

describe("o que o aviso mostra", () => {
  const open = (...alerts: AttentionAlert[]) => new Map(alerts.map((alert) => [alert.key, alert] as const));

  it("um alerta: o texto, de quem, e o botão Responder (Abrir/Ver tarefa para o que não espera o dono)", () => {
    const toast = addToast([], al("a"), NOW, "t1")[0]!;
    expect(toastView(toast, open(al("a")))).toEqual({ title: "Texto a", who: "Eco · Meu Workspace", actionLabel: "Responder", openKey: "a", count: 1 });
    const failedAlert = al("f", { kind: "failed", level: "warn", needsOwner: false });
    expect(toastView(addToast([], failedAlert, NOW, "t2")[0]!, open(failedAlert))?.actionLabel).toBe("Ver tarefa");
    const usageAlert = al("u", { kind: "usage", level: "warn", needsOwner: false });
    expect(toastView(addToast([], usageAlert, NOW, "t3")[0]!, open(usageAlert))?.actionLabel).toBe("Abrir Gastos");
  });

  it("vários juntos: \"3 itens esperando você\", Responder abre o mais antigo; lote com contagem soma", () => {
    let toasts = addToast([], al("a"), NOW, "t1");
    toasts = addToast(toasts, al("b", { count: 2 }), NOW + 1_000, "t2");
    expect(toastView(toasts[0]!, open(al("a"), al("b", { count: 2 })))).toMatchObject({ title: "3 itens esperando você", actionLabel: "Responder", openKey: "a", count: 3 });
    const solo = addToast([], al("c", { count: 3 }), NOW, "t3")[0]!;
    expect(toastView(solo, open(al("c", { count: 3 })))).toMatchObject({ count: 3 });
  });

  it("vários juntos que não esperam o dono (orçamento 80% e 100%): \"2 avisos novos\", sem dizer que esperam você", () => {
    const budget80 = al("b80", { kind: "budget", level: "warn", needsOwner: false });
    const budget100 = al("b100", { kind: "budget", level: "alert", needsOwner: false });
    let toasts = addToast([], budget80, NOW, "t1");
    toasts = addToast(toasts, budget100, NOW + 1_000, "t2");
    expect(toastView(toasts[0]!, open(budget80, budget100))).toMatchObject({ title: "2 avisos novos", actionLabel: "Abrir Gastos", openKey: "b80" });
  });

  it("alerta que já saiu da lista: nada para mostrar", () => {
    expect(toastView(addToast([], al("a"), NOW, "t1")[0]!, open())).toBeNull();
  });
});
