import { readdir } from "node:fs/promises";
import { type CardsResponse, type ForYouItem, type MetricsReport, type RetroGenerateResult, type RetroView, type ServerEvent, type StoredRetro } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp, type TestApp } from "../dev/test-app";
import type { AgentRunner, RunHooks, RunInput, RunOutcome } from "../engines/runner/types";

const setupApp = useTestApp();
const DAY = 24 * 3_600_000;

/** O relógio do app: quinta 12/11/2026 12:00 em São Paulo; o teste o move um dia por vez. */
function fakeClock(start = "2026-11-12T15:00:00.000Z") {
  let ms = Date.parse(start);
  return { now: () => new Date(ms), advance: (by: number) => (ms += by) };
}

/** Agente que sempre pede aprovação de um comentário com emoji (o dono corta os emojis). */
const emojiRunner: AgentRunner = {
  async run(_input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    await hooks.requestApproval({ question: "Posso comentar?", draft: { type: "comentario", text: "Boa leitura 🎉🚀 do texto", where: "Post X" } });
    return { status: "done", result: "feito" };
  },
};

async function ownerCutsEmoji(setup: TestApp, clock: ReturnType<typeof fakeClock>, times: number) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  for (let index = 0; index < times; index += 1) {
    const task = await createTask(setup.app, room.id, team.id, `Comentário ${index + 1}`);
    await setup.log.waitForTask(task.id, "waiting_approval");
    const event = (await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id && e.item.status === "pendente")) as Extract<ServerEvent, { type: "foryou:upserted" }>;
    await call<ForYouItem>(setup.app, "POST", `${wsApi()}/for-you/${event.item.id}/decision`, { status: "aprovado", text: "Boa leitura do texto" }, 200);
    await setup.log.waitForTask(task.id, "done");
    clock.advance(DAY);
  }
  return room.id;
}

describe("API: a retrospectiva (O que aprendemos) de ponta a ponta", () => {
  it("o dono corta emoji 3 vezes em 3 dias: gerar abre o cartão por molde, o lote o recusa, e só o clique grava a regra nas regras do agente", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ runner: emojiRunner, now: clock.now });
    const roomId = await ownerCutsEmoji(setup, clock, 3);
    const runtime = setup.workspaces.get("principal");
    const brainNotes = async (): Promise<string[]> => (await readdir(runtime.brain.dir(roomId)).catch(() => [] as string[])).filter((name) => name.endsWith(".md") && !name.startsWith("_"));

    const before = await call<RetroView>(setup.app, "GET", `${wsApi()}/retro`);
    expect(before.waiting).toBe(0);
    expect(before.ready).toHaveLength(1);
    expect(before.ready[0]).toMatchObject({ trait: "emoji", count: 3, total: 3, template: "Não usar emojis em comentários." });

    const generated = await call<RetroGenerateResult>(setup.app, "POST", `${wsApi()}/retro/generate`, {}, 200);
    expect(generated.opened).toBe(1);
    expect(generated.view.waiting).toBe(1);
    expect(generated.view.rules[0]).toMatchObject({ state: "esperando", source: "molde", text: "Não usar emojis em comentários." });
    // Nada entra no Cérebro sem o clique.
    expect(await brainNotes()).toEqual([]);

    const items = await call<ForYouItem[]>(setup.app, "GET", `${wsApi()}/for-you`);
    const card = items.find((item) => item.kind === "regra")!;
    expect(card).toMatchObject({ status: "pendente", rule: { source: "molde", retro: "2026-W46" } });

    // Aprovar em lote não vale para regra (o lote só leva aprovação de texto).
    const batch = await call<{ error: string }>(setup.app, "POST", `${wsApi()}/for-you/batch`, { ids: [card.id], decision: "aprovado" }, 400);
    expect(batch.error).toContain("não é uma aprovação de texto");
    expect(await brainNotes()).toEqual([]);

    // O clique: aprovar com o texto editado.
    const approved = await call<ForYouItem>(setup.app, "POST", `${wsApi()}/for-you/${card.id}/decision`, { status: "aprovado", rule: { text: "Não usar emojis nos comentários, nunca." } }, 200);
    expect(approved).toMatchObject({ status: "aprovado", decidedBy: "usuario", rule: { text: "Não usar emojis nos comentários, nunca." } });
    // Escopo de um agente: a regra vai para as regras DELE, não para uma nota da sala.
    expect(await brainNotes()).toEqual([]);
    expect((await runtime.agentRules.read(card.agentId)).content).toBe("- Não usar emojis nos comentários, nunca.");
    expect(await call(setup.app, "GET", `${wsApi()}/agents/${card.agentId}/rules`)).toMatchObject({ agentId: card.agentId, content: "- Não usar emojis nos comentários, nunca." });

    // O relatório guardado (reports/retro/2026-W46.json) e as quatro formas dele.
    const report = await call<StoredRetro>(setup.app, "GET", `${wsApi()}/retro/2026-W46`);
    expect(report).toMatchObject({ kind: "retro", period: "2026-W46" });
    expect(report.rules[0]).toMatchObject({ state: "aprovada", text: "Não usar emojis nos comentários, nunca." });
    expect(report.rules[0]!.notePath).toBeUndefined();
    const html = await setup.app.inject({ method: "GET", url: `${wsApi()}/retro/latest?format=html` });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.body).toContain("O que aprendemos");
    const md = await setup.app.inject({ method: "GET", url: `${wsApi()}/retro/2026-W46?format=md` });
    expect(md.body).toContain("Regras propostas");
    await call(setup.app, "GET", `${wsApi()}/retro/2026-W46?format=pdf`, undefined, 400);
    await call(setup.app, "GET", `${wsApi()}/retro/2026-W01`, undefined, 404);
  });

  it("o botão do Maestro sem Maestro de CLI responde 409 (nada é pedido) e o custo aparece antes do clique", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ runner: emojiRunner, now: clock.now });
    await ownerCutsEmoji(setup, clock, 1);
    const view = await call<RetroView>(setup.app, "GET", `${wsApi()}/retro`);
    expect(view.maestro.available).toBe(false);
    expect(view.estimate.groups).toBe(0);
    expect(view.estimate.label).toBe("nenhum padrão para escrever");
    const refused = await call<{ error: string }>(setup.app, "POST", `${wsApi()}/retro/maestro`, {}, 409);
    expect(refused.error).toMatch(/Maestro/);
  });

  it("o bloco da página do Cyno (Card.metrics) tem os mesmos números que a rota /metrics do workspace", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ runner: emojiRunner, now: clock.now });
    await ownerCutsEmoji(setup, clock, 2);
    const metrics = await call<MetricsReport>(setup.app, "GET", `${wsApi()}/metrics`);
    const cards = await call<CardsResponse>(setup.app, "GET", "/api/cyno/cards");
    const card = cards.cards.find((entry) => entry.workspace === "principal")!;
    expect(card.metrics).toBeDefined();
    expect(card.metrics).toMatchObject({
      throughput7d: metrics.throughput.n,
      throughputPrev7d: metrics.throughput.prevN,
      medianCycleMs: metrics.cycleTime.value,
      oldestWaitMs: metrics.approvalWait.pending.oldestMs,
      blocked: metrics.blockedNow.count,
    });
    expect(card.metrics!.weekCostUsd).toBeCloseTo(metrics.spend.usd, 2);
    // Sem Maestro de CLI e sem nada esperando: o resto também bate.
    expect(card.metrics!.waiting).toBe(metrics.approvalWait.pending.count);
  });
});
