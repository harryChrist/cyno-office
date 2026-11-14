import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MURAL_LIMITS, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { cynoMuralTools, muralTools } from "../../mcp/mural-tools";
import type { McpTool } from "../../mcp/protocol";
import { WriteQueue } from "../../store/write-queue";
import { MediaService } from "../../workspace/media/media-service";
import { fakePng } from "../../workspace/media/test-files";
import { ConversationSession, type ConversationHooks } from "../../engines/terminals/conversation-session";
import type { TerminalAgent } from "../../engines/terminals/types";
import { MuralService } from "./mural-service";

const tempDir = useTempDirs();
const queues: { idle(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const NAMES: Record<string, string> = { design: "Design", linkedin: "LinkedIn", instagram: "Instagram" };
let clock = Date.parse("2026-11-10T12:00:00.000Z");
const now = () => new Date(clock);

async function setup() {
  const root = await tempDir();
  clock = Date.parse("2026-11-10T12:00:00.000Z");
  const libraries = new Map<string, MediaService>();
  const events = new Map<string, ServerEvent[]>();
  for (const id of Object.keys(NAMES)) {
    const queue = new WriteQueue();
    queues.push(queue);
    events.set(id, []);
    libraries.set(
      id,
      new MediaService([], {
        dir: path.join(root, id, "media"),
        file: path.join(root, id, "media", "media.json"),
        filesDir: path.join(root, id, "media", "files"),
        queue,
        publish: (event) => events.get(id)!.push(event),
        log: { warn: () => undefined, error: () => undefined },
        now,
      }),
    );
  }
  const mural = await MuralService.openAt(root, now);
  queues.push(mural);
  mural.bind({ workspaceName: (id) => NAMES[id], media: (id) => libraries.get(id) });
  const design = libraries.get("design")!;
  const art = await design.addBuffer(fakePng(1200, 627), "image/png", { title: "Arte do café", createdBy: "ana", origin: "html", note: "capa" });
  return { root, mural, libraries, events, art };
}

const run = async (tools: McpTool[], name: string, args: object) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`sem ferramenta ${name}`);
  return tool.call(tool.input.parse(args));
};

describe("MuralService", () => {
  it("compartilha uma mídia: cria a entrada, marca a mídia, avisa e grava em data/platform/mural", async () => {
    const { root, mural, libraries, art } = await setup();
    let changes = 0;
    mural.subscribe(() => (changes += 1));
    const entry = mural.share({ workspace: "design", by: "design/maestro", mediaId: art.id, note: "Serve para qualquer post de café" });
    expect(entry).toMatchObject({ id: "N-0001", kind: "media", workspace: "design", title: "Arte do café", mediaRef: { workspace: "design", mediaId: "M-0001" }, status: "ativo", usedBy: [] });
    expect(libraries.get("design")!.find(art.id)!.shared).toEqual({ at: "2026-11-10T12:00:00.000Z", note: "Serve para qualquer post de café" });
    expect(changes).toBe(1);
    await mural.idle();
    const saved = JSON.parse(await readFile(path.join(root, "platform", "mural", "mural.json"), "utf8")) as { items: { id: string }[] };
    expect(saved.items.map((item) => item.id)).toEqual(["N-0001"]);
    // Compartilhar de novo atualiza em vez de duplicar.
    const again = mural.share({ workspace: "design", by: "design/maestro", mediaId: art.id, title: "Arte nova", note: "x" });
    expect(again.id).toBe("N-0001");
    expect(mural.list()).toHaveLength(1);
    expect(mural.list()[0]!.title).toBe("Arte nova");
  });

  it("recusa mídia que não existe no workspace e item sem mídia nem texto", async () => {
    const { mural } = await setup();
    expect(() => mural.share({ workspace: "design", by: "x", mediaId: "M-0099" })).toThrow(/não existe neste workspace/);
    expect(() => mural.share({ workspace: "design", by: "x" })).toThrow(/mídia ou um texto/);
    expect(() => mural.share({ workspace: "nada", by: "x", text: "oi", title: "t" })).toThrow(/não encontrado/);
  });

  it("entrega em texto vira nota (ou entrega, com projeto) e respeita o limite de texto", async () => {
    const { mural } = await setup();
    const note = mural.share({ workspace: "design", by: "design/maestro", text: "Paleta: marrom e creme", title: "Paleta" });
    const delivery = mural.share({ workspace: "design", by: "design/maestro", text: "x".repeat(MURAL_LIMITS.text + 500), title: "Resultado", projectId: "P-1" });
    expect(note.kind).toBe("note");
    expect(delivery).toMatchObject({ kind: "deliverable", projectRef: { workspace: "design", projectId: "P-1" } });
    expect(delivery.text).toHaveLength(MURAL_LIMITS.text);
  });

  it("limita a 10 itens por dia por workspace e a 200 ativos (os mais velhos saem)", async () => {
    const { mural } = await setup();
    for (let i = 0; i < MURAL_LIMITS.perDayPerWorkspace; i += 1) mural.share({ workspace: "design", by: "x", text: `texto ${i}`, title: `Item ${i}` });
    expect(() => mural.share({ workspace: "design", by: "x", text: "mais um", title: "Extra" })).toThrow(/Limite/);
    // Outro workspace não é afetado; no dia seguinte volta a poder.
    mural.share({ workspace: "linkedin", by: "x", text: "ok", title: "Do LinkedIn" });
    clock += 25 * 3_600_000;
    for (let i = 0; i < 195; i += 1) {
      mural.share({ workspace: i % 2 === 0 ? "linkedin" : "instagram", by: "x", text: `t${i}`, title: `Lote ${i}` });
      if (i % 9 === 0) clock += 25 * 3_600_000;
    }
    const active = mural.list({ limit: 1000 });
    expect(active.length).toBeLessThanOrEqual(MURAL_LIMITS.active);
    expect(mural.list({ status: "retirado" }).length).toBeGreaterThan(0);
  });

  it("retirar tira a marca da mídia e a entrada some; só quem compartilhou retira como agente", async () => {
    const { mural, libraries, art } = await setup();
    const entry = mural.share({ workspace: "design", by: "design/maestro", mediaId: art.id });
    expect(() => mural.retire(entry.id, "linkedin/maestro", "linkedin")).toThrow(/Só quem compartilhou/);
    mural.retire(entry.id, "dono");
    expect(mural.list()).toHaveLength(0);
    expect(libraries.get("design")!.find(art.id)!.shared).toBeUndefined();
  });

  it("cursor por workspace: o aviso entra uma única vez, só com itens de OUTROS workspaces", async () => {
    const { mural, art } = await setup();
    mural.share({ workspace: "design", by: "design/maestro", mediaId: art.id, title: "Vídeo do lançamento" });
    // O próprio workspace nunca recebe o aviso do que ele mesmo publicou.
    expect(mural.takeNews("design")).toBe("");
    const first = mural.takeNews("linkedin");
    expect(first).toContain("Novo no mural da plataforma");
    expect(first).toContain("N-0001 “Vídeo do lançamento” (Design)");
    expect(first).toContain("mural_use");
    // Segunda mensagem: nada (o cursor avançou); o do Instagram, que nunca viu, ainda recebe.
    expect(mural.takeNews("linkedin")).toBe("");
    expect(mural.takeNews("instagram")).toContain("N-0001");
    expect(mural.find("N-0001")!.seenBy).toMatchObject({ linkedin: expect.any(String), instagram: expect.any(String) });
    // Um item novo depois do cursor volta a avisar, só ele.
    clock += 60_000;
    mural.share({ workspace: "instagram", by: "x", text: "ideia", title: "Ideia de reels" });
    const next = mural.takeNews("linkedin");
    expect(next).toContain("N-0002");
    expect(next).not.toContain("N-0001");
  });

  it("o aviso é curto (5 linhas) e conta o resto; o cursor sobrevive a reabrir", async () => {
    const { root, mural } = await setup();
    for (let i = 0; i < 8; i += 1) {
      mural.share({ workspace: "design", by: "x", text: `t${i}`, title: `Item ${i}` });
      clock += 1000;
    }
    const text = mural.takeNews("linkedin");
    expect(text.match(/N-\d{4}/g)).toHaveLength(5);
    expect(text).toContain("e mais 3");
    expect(text.length).toBeLessThan(900);
    await mural.idle();
    const reopened = await MuralService.openAt(root, now);
    queues.push(reopened);
    reopened.bind({ workspaceName: (id) => NAMES[id], media: () => undefined });
    expect(reopened.takeNews("linkedin")).toBe("");
    expect(reopened.newsCounts(["instagram", "linkedin"])).toEqual({ instagram: 8, linkedin: 0 });
  });

  it("mural_use copia o arquivo para a biblioteca do outro workspace, com origem e rascunho", async () => {
    const { mural, libraries, art } = await setup();
    const entry = mural.share({ workspace: "design", by: "design/maestro", mediaId: art.id, note: "capa de café" });
    const used = await mural.use(entry.id, "linkedin", "linkedin/maestro", "maestro");
    expect(used.mediaId).toBe("M-0001");
    const copy = libraries.get("linkedin")!.find("M-0001")!;
    expect(copy).toMatchObject({ title: "Arte do café", origin: "mural", status: "rascunho", createdBy: "maestro", kind: "image", width: 1200, height: 627 });
    expect(copy.note).toBe("Do mural: Design · N-0001 — capa de café");
    expect((await stat(libraries.get("linkedin")!.fileOf(copy))).size).toBe(33);
    // A original continua no Design e a entrada lembra quem usou.
    expect(libraries.get("design")!.find(art.id)).toBeDefined();
    expect(mural.find(entry.id)!.usedBy).toEqual(["linkedin"]);
    // Do próprio workspace não copia; item retirado não existe.
    await expect(mural.use(entry.id, "design", "dono")).rejects.toMatchObject({ statusCode: 409 });
    mural.retire(entry.id, "dono");
    await expect(mural.use(entry.id, "instagram", "dono")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("mídia apagada no workspace de origem tira o item do mural; uma nota em texto vem como texto", async () => {
    const { mural, libraries, art } = await setup();
    mural.share({ workspace: "design", by: "x", mediaId: art.id });
    const note = mural.share({ workspace: "design", by: "x", text: "Paleta: marrom", title: "Paleta" });
    expect((await mural.use(note.id, "linkedin", "dono")).text).toBe("Paleta: marrom");
    await libraries.get("design")!.delete(art.id);
    expect(mural.list().map((entry) => entry.id)).toEqual([note.id]);
  });
});

describe("ferramentas mural_*", () => {
  async function tools() {
    const ctx = await setup();
    const agent = (workspace: string) => muralTools({ mural: ctx.mural, workspace, address: `${workspace}/maestro`, agentId: "maestro", workspaceName: (id) => NAMES[id] });
    const cyno = cynoMuralTools({ mural: ctx.mural, workspaces: () => Object.entries(NAMES).map(([id, name]) => ({ id, name })), workspaceName: (id) => NAMES[id] });
    return { ...ctx, agent, cyno };
  }

  it("escopos: o agente tem mural_share/list/use/unshare sem parâmetro workspace; o Cyno tem o mesmo com workspace", async () => {
    const { agent, cyno } = await tools();
    const expected = ["mural_list", "mural_share", "mural_unshare", "mural_use"];
    expect(agent("design").map((tool) => tool.name).sort()).toEqual(expected);
    expect(cyno.map((tool) => tool.name).sort()).toEqual(expected);
    const shape = (tool: McpTool) => Object.keys(tool.input.shape);
    expect(shape(agent("design").find((tool) => tool.name === "mural_share")!)).not.toContain("workspace");
    expect(shape(cyno.find((tool) => tool.name === "mural_share")!)).toContain("workspace");
    expect(shape(cyno.find((tool) => tool.name === "mural_use")!)).toContain("workspace");
  });

  it("um agente só compartilha como o próprio workspace e mural_use traz a imagem", async () => {
    const { agent, art, libraries } = await tools();
    const shared = await run(agent("design"), "mural_share", { media_id: art.id, title: "Arte do café", note: "ótima" });
    expect(shared.isError).toBeUndefined();
    expect(shared.text).toContain("N-0001");
    expect((await run(agent("design"), "mural_share", { media_id: "M-0042", title: "x" })).isError).toBe(true);
    const listed = await run(agent("linkedin"), "mural_list", {});
    expect(listed.text).toContain("N-0001");
    expect(listed.text).toContain("Design (design)");
    const used = await run(agent("linkedin"), "mural_use", { item_id: "N-0001" });
    expect(used.text).toContain("M-0001");
    expect(libraries.get("linkedin")!.find("M-0001")!.origin).toBe("mural");
    // Agente de outro workspace não retira o que não é dele.
    expect((await run(agent("linkedin"), "mural_unshare", { item_id: "N-0001" })).isError).toBe(true);
    expect((await run(agent("design"), "mural_unshare", { item_id: "N-0001" })).isError).toBeUndefined();
  });

  it("o Cyno compartilha em nome de um workspace (por nome) e vê tudo", async () => {
    const { cyno, art, mural } = await tools();
    const shared = await run(cyno, "mural_share", { workspace: "Design", media_id: art.id, title: "Arte" });
    expect(shared.isError).toBeUndefined();
    expect(mural.find("N-0001")!.by).toBe("cyno");
    expect((await run(cyno, "mural_share", { workspace: "Inexistente", result: "oi", title: "x" })).isError).toBe(true);
    expect((await run(cyno, "mural_use", { workspace: "linkedin", item_id: "N-0001" })).text).toContain("M-0001");
    expect((await run(cyno, "mural_list", {})).text).toContain("used by linkedin");
  });
});

describe("aviso do mural na ConversationSession", () => {
  /** Terminal falso: guarda o texto de cada mensagem que sai. */
  function fakeTerminal(sent: string[]): TerminalAgent {
    return { provider: "claude", send: (text: string) => void sent.push(text), onEvent: () => () => undefined } as unknown as TerminalAgent;
  }

  it("entra no fim da próxima mensagem que de fato sai, uma única vez, e nada é enviado só por causa dele", async () => {
    const { mural, art } = await setup();
    const sent: string[] = [];
    const terminal = fakeTerminal(sent);
    const hooks: ConversationHooks = {
      label: "Teste",
      sessionKeyPrefix: "t",
      log: { info: () => undefined, error: () => undefined },
      isStopped: () => false,
      locate: () => ({ id: "maestro", terminal }),
      onTerminalEvent: () => undefined,
      blocked: () => undefined,
      rotateTokens: () => 0,
      seed: () => "",
    };
    const session = new ConversationSession(hooks);
    session.addExtra(() => mural.takeNews("linkedin"));
    mural.share({ workspace: "design", by: "x", mediaId: art.id, title: "Vídeo do lançamento" });
    // Compartilhar não envia nada ao Maestro.
    expect(sent).toHaveLength(0);
    session.push("chat:1", "oi");
    session.push("chat:2", "e agora?");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("oi");
    expect(sent[0]).toContain("Novo no mural da plataforma: N-0001 “Vídeo do lançamento” (Design)");
    expect(sent[1]).toBe("e agora?");
  });
});
