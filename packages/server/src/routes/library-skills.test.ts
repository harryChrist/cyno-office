import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry, ApiErrorBody, ImportLibrarySkillsResponse, LibrarySkillDetail, LibrarySkillView, ServerEvent, SkillImportResponse } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createTeam, createWorkspace } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { writeAuthFile } from "../platform/auth/store";
import { setActivityLog, type ActivityLog } from "../workspace/activity/log";

const setupApp = useTestApp();
const tempDir = useTempDirs();
const SK = "/api/library/skills";
const md = (name: string, description = "Use quando a tarefa pedir exatamente isto aqui.", body = "Corpo.\n") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

afterEach(() => setActivityLog(undefined));

/** Dois workspaces com um agente cada, mais um home falso com uma skill para importar. */
async function twoWorkspaces() {
  const home = await tempDir();
  await mkdir(path.join(home, ".claude", "skills", "do-dono"), { recursive: true });
  await writeFile(path.join(home, ".claude", "skills", "do-dono", "SKILL.md"), md("Do dono", "Use quando precisar da skill pessoal do dono."));
  const test = await setupApp({ skillsHome: home });
  const other = await createWorkspace(test.app, "Outro");
  const room = await createRoom(test.app, "Sala", {}, other.id);
  const team = await createTeam(test.app, room.id, "Time", other.id);
  const dora = await createAgent(test.app, team.id, "Dora", other.id);
  const pRoom = await createRoom(test.app, "Sala P");
  const pTeam = await createTeam(test.app, pRoom.id, "Time P");
  const clara = await createAgent(test.app, pTeam.id, "Clara");
  return { ...test, other: other.id, dora, clara, home };
}

describe("API: skills da Biblioteca", () => {
  it("cria do texto (nada liberado), lê o detalhe com o SKILL.md, valida e dá erro claro", async () => {
    const test = await twoWorkspaces();
    const created = await call<LibrarySkillView>(test.app, "POST", SK, { content: md("Carrossel de post", "Use quando precisar de um carrossel de post em HTML.", "regras\n") });
    expect(created).toMatchObject({ id: "carrossel-de-post", name: "Carrossel de post", version: 1, grants: {}, uses: [], readonly: false, hasPrevious: false, origin: { kind: "manual" } });
    expect(created.indexTokens).toBeGreaterThan(5);
    expect(created.weightTokens).toBeGreaterThan(5);
    const detail = await call<LibrarySkillDetail>(test.app, "GET", `${SK}/carrossel-de-post`);
    expect(detail.content).toContain("regras");
    expect(detail.fileList).toEqual([{ path: "SKILL.md", bytes: Buffer.byteLength(detail.content) }]);
    expect((await call<LibrarySkillView[]>(test.app, "GET", SK)).map((s) => s.id)).toEqual(["carrossel-de-post"]);
    const bad = await call<ApiErrorBody>(test.app, "POST", SK, { content: "sem frontmatter" }, 400);
    expect(bad.error).toMatch(/frontmatter/);
    await call(test.app, "GET", `${SK}/nao-existe`, undefined, 404);
    // Os arquivos moram na plataforma.
    expect(await readdir(path.join(test.dataDir, "platform", "library", "skills"))).toEqual(["carrossel-de-post"]);
  });

  it("atualiza (versão sobe, anterior guardada), restaura, duplica e exclui", async () => {
    const test = await twoWorkspaces();
    await call(test.app, "POST", SK, { content: md("Viva", "Use quando for a primeira versão.", "v1\n") });
    const up = await call<LibrarySkillView>(test.app, "PUT", `${SK}/viva`, { content: md("Viva", "Use quando for a segunda versão.", "v2\n") });
    expect(up).toMatchObject({ version: 2, hasPrevious: true, previousVersion: 1 });
    const back = await call<LibrarySkillView>(test.app, "POST", `${SK}/viva/restore`, undefined, 200);
    expect(back).toMatchObject({ version: 3, description: "Use quando for a primeira versão." });
    const copy = await call<LibrarySkillView>(test.app, "POST", `${SK}/viva/duplicate`);
    expect(copy.name).toBe("Viva (cópia)");
    await call(test.app, "DELETE", `${SK}/viva`, undefined, 204);
    await call(test.app, "GET", `${SK}/viva`, undefined, 404);
    await call(test.app, "POST", `${SK}/viva-copia/restore`, undefined, 409);
  });

  it("upload de pasta e de .zip; recusa nome inseguro e executável", async () => {
    const test = await twoWorkspaces();
    const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
    const folder = await call<LibrarySkillView>(test.app, "POST", `${SK}/upload`, { files: [{ path: "pasta/SKILL.md", dataBase64: b64(md("Da pasta")) }, { path: "pasta/ref.md", dataBase64: b64("ref") }] });
    expect(folder).toMatchObject({ id: "da-pasta", files: 2, origin: { kind: "upload" } });
    const unsafe = await call<ApiErrorBody>(test.app, "POST", `${SK}/upload`, { files: [{ path: "SKILL.md", dataBase64: b64(md("X")) }, { path: "../fora.md", dataBase64: b64("x") }] }, 400);
    expect(unsafe.error).toMatch(/não permitido/);
    const exe = await call<ApiErrorBody>(test.app, "POST", `${SK}/upload`, { files: [{ path: "SKILL.md", dataBase64: b64(md("X")) }, { path: "a.bin", dataBase64: b64(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) }] }, 400);
    expect(exe.error).toMatch(/executável/);
    await call(test.app, "POST", `${SK}/upload`, { files: [] }, 400);
    await call(test.app, "POST", `${SK}/upload`, { zipBase64: b64("não é zip") }, 400);
  });

  it("importa por cópia do home do dono: lista candidatas, copia a marcada e não toca no original", async () => {
    const test = await twoWorkspaces();
    const original = path.join(test.home, ".claude", "skills", "do-dono", "SKILL.md");
    const before = await readFile(original, "utf8");
    const { candidates } = await call<SkillImportResponse>(test.app, "GET", `${SK}/import/candidates`);
    expect(candidates.map((c) => c.name)).toEqual(["Do dono"]);
    const result = await call<ImportLibrarySkillsResponse>(test.app, "POST", `${SK}/import`, { keys: [candidates[0]!.key] }, 201);
    expect(result.imported[0]).toMatchObject({ id: "do-dono", origin: { kind: "folder", from: "~/.claude/skills" }, grants: {} });
    expect(await readFile(original, "utf8")).toBe(before);
    const failed = await call<ImportLibrarySkillsResponse>(test.app, "POST", `${SK}/import`, { keys: ["0123456789abcdef"] }, 200);
    expect(failed.failed).toHaveLength(1);
  });

  it("libera nos dois níveis, mostra 'quem usa' com nomes, atualiza ao vivo (eventos) e registra na Atividade", async () => {
    const test = await twoWorkspaces();
    const events: ServerEvent[] = [];
    test.workspaces.listHub.subscribe((event) => events.push(event));
    const entries: ActivityEntry[] = [];
    setActivityLog({ record: (input: Omit<ActivityEntry, "id" | "at">) => entries.push(input as ActivityEntry) } as unknown as ActivityLog);
    await call(test.app, "POST", SK, { content: md("Alfa") });
    const granted = await call<LibrarySkillView>(test.app, "PUT", `${SK}/alfa/grants`, { grants: { principal: { agentIds: [test.clara.id] }, [test.other]: { agentIds: [] } } });
    expect(granted.uses.map((use) => [use.workspaceId, use.agents.map((agent) => agent.name)])).toEqual([[test.other, []], ["principal", ["Clara"]]]);
    // O agente de outro workspace não vale.
    await call(test.app, "PUT", `${SK}/alfa/grants`, { grants: { principal: { agentIds: [test.dora.id] } } }, 404);
    await call(test.app, "PUT", `${SK}/alfa/grants`, { grants: { fantasma: { agentIds: [] } } }, 404);
    expect(events.filter((event) => event.type === "library:skill-upserted").length).toBeGreaterThanOrEqual(2);
    const actions = entries.map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["skill-criada", "skill-liberada"]));
    // Excluir a skill avisa e a Atividade anota.
    await call(test.app, "DELETE", `${SK}/alfa`, undefined, 204);
    expect(events.some((event) => event.type === "library:skill-deleted" && event.id === "alfa")).toBe(true);
    expect(entries.map((entry) => entry.action)).toContain("skill-removida");
  });

  it("workspace excluído e agente excluído saem das liberações das skills", async () => {
    const test = await twoWorkspaces();
    await call(test.app, "POST", SK, { content: md("Alfa") });
    await call(test.app, "PUT", `${SK}/alfa/grants`, { grants: { principal: { agentIds: [test.clara.id] }, [test.other]: { agentIds: [test.dora.id] } } });
    await call(test.app, "DELETE", `/api/w/principal/agents/${test.clara.id}`);
    let alfa = (await call<LibrarySkillView[]>(test.app, "GET", SK))[0]!;
    expect(alfa.grants.principal!.agentIds).toEqual([]);
    await call(test.app, "DELETE", `/api/workspaces/${test.other}`);
    alfa = (await call<LibrarySkillView[]>(test.app, "GET", SK))[0]!;
    expect(Object.keys(alfa.grants)).toEqual(["principal"]);
  });

  it("atrás da senha: sem sessão é 401 em todas as rotas; o token de agente não abre a Biblioteca", async () => {
    const test = await twoWorkspaces();
    await call(test.app, "POST", SK, { content: md("Alfa") });
    await writeAuthFile(test.dataDir, "senha-de-teste-1");
    const routes: [string, string, unknown?][] = [
      ["GET", SK],
      ["POST", SK, { content: md("X") }],
      ["GET", `${SK}/alfa`],
      ["PUT", `${SK}/alfa`, { content: md("X") }],
      ["DELETE", `${SK}/alfa`],
      ["PUT", `${SK}/alfa/grants`, { grants: {} }],
      ["POST", `${SK}/alfa/restore`],
      ["POST", `${SK}/alfa/duplicate`],
      ["GET", `${SK}/import/candidates`],
      ["POST", `${SK}/import`, { keys: ["a"] }],
      ["POST", `${SK}/upload`, { files: [] }],
    ];
    for (const [method, url, payload] of routes) {
      const response = await test.app.inject({ method: method as "GET", url, ...(payload ? { payload: payload as object } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    const bearer = await test.app.inject({ method: "GET", url: SK, headers: { authorization: "Bearer tok-de-agente" } });
    expect(bearer.statusCode).toBe(401);
    const login = await test.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste-1" } });
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] as string)[0]).split(";")[0]!;
    expect((await test.app.inject({ method: "GET", url: SK, headers: { cookie } })).statusCode).toBe(200);
  });
});
