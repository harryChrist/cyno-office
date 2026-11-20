import type { ScriptRun } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { hashFor, parseHash } from "../../store/navStore";
import { byNewest, groupRuns, LOST_NOTICE, parseScriptSub, removeRun, runNotices, runningChipLabel, runningCount, runningOfAgent, sizeLabel, statusText, statusTone, TRUNCATED_NOTICE, upsertRun } from "./scriptsView";

function run(id: string, extra: Partial<ScriptRun> = {}): ScriptRun {
  return {
    id,
    agentId: "a1",
    agentName: "Dev",
    title: `Script ${id}`,
    command: "echo oi",
    cwd: "/tmp",
    status: "running",
    startedAt: `2026-11-19T10:0${id.slice(1)}:00.000Z`,
    deadlineAt: "2026-11-19T12:00:00.000Z",
    bytes: 0,
    truncated: false,
    fenced: false,
    ...extra,
  };
}

describe("endereço", () => {
  it("lê o id do script na aba da página", () => {
    expect(parseScriptSub("s12")).toBe("s12");
    expect(parseScriptSub("s12?x=1")).toBe("s12");
    expect(parseScriptSub("s12/mais")).toBe("s12");
  });
  it("sem id válido, é a lista", () => {
    expect(parseScriptSub(undefined)).toBeNull();
    expect(parseScriptSub("")).toBeNull();
    expect(parseScriptSub("abc")).toBeNull();
    expect(parseScriptSub("%E0%A4%A")).toBeNull();
  });
});

describe("rota da página", () => {
  it("#/<ws>/scripts/<id> abre a página no script", () => {
    const location = parseHash("#/principal/scripts/s12");
    expect(location).toEqual({ workspaceId: "principal", page: "scripts", sub: "s12" });
    expect(parseScriptSub(location.sub)).toBe("s12");
    expect(hashFor(location)).toBe("#/principal/scripts/s12");
    expect(parseHash("#/principal/scripts")).toEqual({ workspaceId: "principal", page: "scripts" });
  });
});

describe("lista", () => {
  it("agrupa rodando e terminados, cada um do mais novo para o mais velho", () => {
    const runs = [run("s1", { status: "done" }), run("s2"), run("s3", { status: "failed" }), run("s4")];
    const { running, finished } = groupRuns(runs);
    expect(running.map((item) => item.id)).toEqual(["s4", "s2"]);
    expect(finished.map((item) => item.id)).toEqual(["s3", "s1"]);
    expect(runningCount(runs)).toBe(2);
  });
  it("mesmo horário: o id maior é o mais novo, e s10 vem depois de s9", () => {
    const at = "2026-11-19T10:00:00.000Z";
    expect([run("s9", { startedAt: at }), run("s10", { startedAt: at })].sort(byNewest).map((item) => item.id)).toEqual(["s10", "s9"]);
  });
  it("só os do agente que rodam agora", () => {
    const runs = [run("s1"), run("s2", { agentId: "a2" }), run("s3", { status: "done" }), run("s4")];
    expect(runningOfAgent(runs, "a1").map((item) => item.id)).toEqual(["s4", "s1"]);
  });
});

describe("eventos", () => {
  it("script:updated inclui o novo e troca o que já existe", () => {
    const first = upsertRun([], run("s1"));
    expect(first).toHaveLength(1);
    const next = upsertRun(first, run("s1", { status: "done", bytes: 9 }));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ status: "done", bytes: 9 });
    expect(upsertRun(next, run("s2")).map((item) => item.id)).toEqual(["s2", "s1"]);
  });
  it("script:removed tira só o id", () => {
    expect(removeRun([run("s1"), run("s2")], "s1").map((item) => item.id)).toEqual(["s2"]);
    expect(removeRun([run("s1")], "s9")).toHaveLength(1);
  });
});

describe("rótulos", () => {
  it("estado: quem parou e o código de saída", () => {
    expect(statusText(run("s1"))).toBe("Rodando");
    expect(statusText(run("s1", { status: "stopped", stoppedBy: "user" }))).toBe("Parado por você");
    expect(statusText(run("s1", { status: "failed", exitCode: 2 }))).toBe("Terminou com erro (código 2)");
    expect(statusText(run("s1", { status: "failed", exitCode: null }))).toBe("Terminou com erro");
    expect(statusText(run("s1", { status: "lost" }))).toBe("Interrompido");
  });
  it("tom de cada estado", () => {
    expect(statusTone("running")).toBe("live");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("done")).toBe("ok");
  });
  it("tamanho da saída", () => {
    expect(sizeLabel(0)).toBe("0 B");
    expect(sizeLabel(1023)).toBe("1023 B");
    expect(sizeLabel(1536)).toBe("1,5 KB");
    expect(sizeLabel(20 * 1024)).toBe("20 KB");
    expect(sizeLabel(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });
  it("avisos do visualizador", () => {
    expect(runNotices(run("s1"))).toEqual([]);
    expect(runNotices(run("s1", { truncated: true, status: "lost" }))).toEqual([TRUNCATED_NOTICE, LOST_NOTICE]);
  });
  it("chip do agente no singular e no plural", () => {
    expect(runningChipLabel(1)).toBe("1 script rodando");
    expect(runningChipLabel(2)).toBe("2 scripts rodando");
  });
});
