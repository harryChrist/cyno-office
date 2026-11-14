import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AWAY_PATH, AWAY_SEEN_PATH, PRESENCE_PATH, type AwayResponse, type PresenceResponse } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { call, createTask, soloTeam } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();
const HOUR = 3_600_000;

describe("API: presença e \"enquanto você estava fora\"", () => {
  it("primeira presença e ausência curta: nada a mostrar", async () => {
    const clock = { now: new Date("2026-11-12T12:00:00.000Z") };
    const { app } = await setupApp({ now: () => clock.now });
    expect(await call<PresenceResponse>(app, "POST", PRESENCE_PATH, undefined, 200)).toEqual({ awayPending: false });
    clock.now = new Date(clock.now.getTime() + 20 * 60_000);
    expect(await call<PresenceResponse>(app, "POST", PRESENCE_PATH, undefined, 200)).toEqual({ awayPending: false });
    expect(await call<AwayResponse>(app, "GET", AWAY_PATH)).toEqual({ pending: false });
  });

  it("ausência longa sem novidades: não aparece (nem pendente)", async () => {
    const clock = { now: new Date("2026-11-12T12:00:00.000Z") };
    const { app } = await setupApp({ now: () => clock.now });
    await call(app, "POST", PRESENCE_PATH, undefined, 200);
    clock.now = new Date(clock.now.getTime() + 2 * HOUR);
    // O servidor registra a ausência, mas sem novidade o resumo vem vazio e o cartão não abre.
    expect((await call<PresenceResponse>(app, "POST", PRESENCE_PATH, undefined, 200)).awayPending).toBe(true);
    expect(await call<AwayResponse>(app, "GET", AWAY_PATH)).toEqual({ pending: false });
  });

  it("ausência longa com uma tarefa concluída e uma aprovação: o resumo mostra; \"Ok, vi\" zera para todo mundo", async () => {
    const real = Date.now();
    const clock = { now: new Date(real - 2 * HOUR) };
    const { app, log } = await setupApp({ now: () => clock.now });
    await call(app, "POST", PRESENCE_PATH, undefined, 200);
    // O app carimba as tarefas com o relógio dele: a hora do trabalho cai na ausência (uma hora depois de o dono sair).
    clock.now = new Date(real - HOUR);
    const solo = await soloTeam(app);
    const done = await createTask(app, solo.room.id, solo.team.id, "Escrever o post de sexta [entregar]");
    await log.waitForTask(done.id, "done");
    const wait = await createTask(app, solo.room.id, solo.team.id, "Publicar o post [aprovar]");
    await log.waitForTask(wait.id, "waiting_approval");
    clock.now = new Date(real + 60_000);
    expect((await call<PresenceResponse>(app, "POST", PRESENCE_PATH, undefined, 200)).awayPending).toBe(true);

    const away = await call<AwayResponse>(app, "GET", AWAY_PATH);
    expect(away.pending).toBe(true);
    const workspace = away.summary!.workspaces[0]!;
    expect(workspace.id).toBe("principal");
    expect(workspace.done.map((task) => task.title)).toEqual(["Escrever o post de sexta [entregar]"]);
    expect(workspace.approvalsCount).toBe(1);
    expect(workspace.approvals[0]!.target).toMatchObject({ page: "para-voce", workspaceId: "principal" });
    expect(away.summary!.totals.done).toBe(1);

    // Outro navegador (a mesma presença guardada no servidor) vê o mesmo; o "Ok, vi" de um zera o do outro.
    await vi.waitFor(async () => expect((await call<AwayResponse>(app, "GET", AWAY_PATH)).pending).toBe(true));
    expect((await app.inject({ method: "POST", url: AWAY_SEEN_PATH })).statusCode).toBe(204);
    expect(await call<AwayResponse>(app, "GET", AWAY_PATH)).toEqual({ pending: false });
    expect((await call<PresenceResponse>(app, "POST", PRESENCE_PATH, undefined, 200)).awayPending).toBe(false);
  });

  it("a ferramenta get_away_summary do Cyno devolve o mesmo resumo (em inglês), mesmo depois do \"Ok, vi\"", async () => {
    const real = Date.now();
    const clock = { now: new Date(real - 2 * HOUR) };
    const { app, log } = await setupApp({ now: () => clock.now });
    const tool = () => app.cyno.tools().find((candidate) => candidate.name === "get_away_summary")!;
    expect((await tool().call({} as never)).text).toContain("No absence recorded yet");
    await call(app, "POST", PRESENCE_PATH, undefined, 200);
    clock.now = new Date(real - HOUR);
    const solo = await soloTeam(app);
    const done = await createTask(app, solo.room.id, solo.team.id, "Escrever o post de sexta [entregar]");
    await log.waitForTask(done.id, "done");
    clock.now = new Date(real + 60_000);
    await call(app, "POST", PRESENCE_PATH, undefined, 200);
    const text = (await tool().call({} as never)).text;
    expect(text).toContain("While the owner was away");
    expect(text).toContain("- done: Escrever o post de sexta [entregar]");
    await app.inject({ method: "POST", url: AWAY_SEEN_PATH });
    expect((await tool().call({} as never)).text).toContain("already dismissed the card");
  });

  it("a presença é guardada em data/platform/owner.json e a ausência sobrevive a um reinício", async () => {
    const clock = { now: new Date("2026-11-12T12:00:00.000Z") };
    const first = await setupApp({ now: () => clock.now });
    await call(first.app, "POST", PRESENCE_PATH, undefined, 200);
    clock.now = new Date(clock.now.getTime() + 3 * HOUR);
    await call(first.app, "POST", PRESENCE_PATH, undefined, 200);
    await first.app.close();
    const file = path.join(first.dataDir, "platform", "owner.json");
    expect(JSON.parse(await readFile(file, "utf8")).episode).toMatchObject({ since: "2026-11-12T12:00:00.000Z" });
    const second = await setupApp({ dataDir: first.dataDir, now: () => clock.now });
    expect((await call<PresenceResponse>(second.app, "POST", PRESENCE_PATH, undefined, 200)).awayPending).toBe(true);
    await writeFile(file, "{}");
  });
});
