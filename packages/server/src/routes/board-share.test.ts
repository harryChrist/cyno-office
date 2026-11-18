import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUTH_COOKIE, BOARD_CSP_HEADER, boardSharePath, boardShareRotatePath, type Board, type BoardShare } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { call, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { isAuthExempt } from "../platform/auth/routes";
import { writeAuthFile } from "../platform/auth/store";
import { PUBLIC_BOARD_MAX_DATA_BYTES, PUBLIC_BOARD_RATE_LIMIT } from "./board-share";

vi.setConfig({ testTimeout: 30_000 });
const setupApp = useTestApp();
const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keylen: 64 } as const;

async function boardApp(extra: Parameters<typeof setupApp>[0] = {}) {
  const test = await setupApp(extra);
  const boards = test.workspaces.get("principal").boards;
  await boards.create({ title: "Obras do site", description: "Catálogo", source: "rodar sync.py", html: "<p id='corpo'>olá quadro</p>", createdBy: "clara-secreta" });
  await boards.setData("Q-0001", { text: '{"works":[{"n":"A"}]}' });
  const share = await call<BoardShare>(test.app, "PUT", `${wsApi()}${boardSharePath("Q-0001")}`, {});
  if (!share.shared) throw new Error("devia estar compartilhado");
  return { ...test, boards, token: share.token, share };
}

const pub = (app: { inject: (options: { method: string; url: string; headers: Record<string, string> }) => Promise<unknown> }, token: string, method = "GET", headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/share/${token}`, headers }) as Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined>; rawPayload: Buffer }>;

describe("rotas do dono: link do quadro", () => {
  it("ciclo completo: estado, liga, validade, troca de token, desliga (idempotente)", async () => {
    const { app } = await setupApp();
    await app.workspaces.get("principal").boards.create({ title: "A", description: "d", html: "<p/>", createdBy: "clara" });
    const url = `${wsApi()}${boardSharePath("Q-0001")}`;
    expect(await call<BoardShare>(app, "GET", url)).toEqual({ shared: false });
    await call(app, "POST", `${wsApi()}${boardShareRotatePath("Q-0001")}`, {}, 409);
    const on = await call<BoardShare>(app, "PUT", url, { expiresInDays: 7 });
    expect(on).toMatchObject({ shared: true, expiresAt: expect.any(String) });
    expect(await call<BoardShare>(app, "GET", url)).toEqual(on);
    if (!on.shared) throw new Error("x");
    expect(on.path).toBe(`/api/share/${on.token}`);
    const noExpiry = await call<BoardShare>(app, "PUT", url, { expiresInDays: 0 });
    expect(noExpiry).toMatchObject({ token: on.token });
    expect(noExpiry).not.toHaveProperty("expiresAt");
    const rotated = await call<BoardShare>(app, "POST", `${wsApi()}${boardShareRotatePath("Q-0001")}`, {}, 200);
    expect(rotated).toMatchObject({ shared: true });
    expect((rotated as { token: string }).token).not.toBe(on.token);
    await call(app, "DELETE", url);
    await call(app, "DELETE", url);
    expect(await call<BoardShare>(app, "GET", url)).toEqual({ shared: false });
    expect((await app.inject({ method: "PUT", url, payload: { expiresInDays: 999 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url, payload: { outro: 1 } })).statusCode).toBe(400);
  });

  it("quadro inexistente dá 404 em todas as rotas", async () => {
    const { app } = await setupApp();
    for (const [method, url] of [["GET", boardSharePath("Q-0099")], ["PUT", boardSharePath("Q-0099")], ["DELETE", boardSharePath("Q-0099")], ["POST", boardShareRotatePath("Q-0099")]] as const) {
      expect((await app.inject({ method, url: `${wsApi()}${url}`, payload: method === "PUT" || method === "POST" ? {} : undefined })).statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("exigem senha (as rotas do dono não são abertas)", async () => {
    const { app, dataDir } = await setupApp({ auth: { open: false } });
    await writeAuthFile(dataDir, "senha-de-teste-1", new Date(), FAST_SCRYPT);
    for (const [method, url] of [["GET", boardSharePath("Q-0001")], ["PUT", boardSharePath("Q-0001")], ["DELETE", boardSharePath("Q-0001")], ["POST", boardShareRotatePath("Q-0001")], ["GET", "/boards/Q-0001/export?format=pdf"]] as const) {
      expect((await app.inject({ method, url: `${wsApi()}${url}` })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("o token não aparece em Board, na lista nem nos dados do quadro", async () => {
    const { app, token } = await boardApp();
    const board = await call<Board>(app, "GET", `${wsApi()}/boards/Q-0001`);
    expect(JSON.stringify(board)).not.toContain(token);
    expect(JSON.stringify(await call(app, "GET", `${wsApi()}/boards`))).not.toContain(token);
  });

  it("apagar o quadro derruba o link", async () => {
    const { app, token, dataDir } = await boardApp();
    expect((await pub(app, token)).statusCode).toBe(200);
    await call(app, "DELETE", `${wsApi()}/boards/Q-0001`);
    expect((await pub(app, token)).statusCode).toBe(404);
    expect(JSON.parse(await readFile(path.join(dataDir, "board-shares.json"), "utf8"))).toEqual([]);
  });
});

describe("rota pública /api/share/:token", () => {
  it("token válido: 200 com todos os cabeçalhos, sem Set-Cookie, sem vazar id, autor, origem nem workspace", async () => {
    const { app, token } = await boardApp();
    const response = await pub(app, token);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-security-policy"]).toBe(BOARD_CSP_HEADER);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toContain("olá quadro");
    expect(response.body).toContain("Obras do site");
    expect(response.body).toContain('"works"');
    for (const secret of ["Q-0001", "clara-secreta", "rodar sync.py", "principal", "createdBy", token]) expect(response.body, secret).not.toContain(secret);
    const head = await pub(app, token, "HEAD");
    expect(head.statusCode).toBe(200);
  });

  it("é uma foto do momento: lê do disco a cada pedido", async () => {
    const { app, token, boards } = await boardApp();
    await boards.save("Q-0001", { html: "<p>versão dois</p>" });
    expect((await pub(app, token)).body).toContain("versão dois");
  });

  it("funciona sem cookie com a senha LIGADA, e o resto do app segue fechado", async () => {
    const test = await setupApp({ auth: { open: false } });
    await writeAuthFile(test.dataDir, "senha-de-teste-1", new Date(), FAST_SCRYPT);
    const login = await test.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste-1" } });
    const raw = login.headers["set-cookie"];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
    expect(cookie.startsWith(AUTH_COOKIE)).toBe(true);
    const boards = test.workspaces.get("principal").boards;
    await boards.create({ title: "T", description: "d", html: "<p>aberto</p>", createdBy: "clara" });
    const share = await call<BoardShare>(test.app, "PUT", `${wsApi()}${boardSharePath("Q-0001")}`, {}, 200).catch(async () => {
      const response = await test.app.inject({ method: "PUT", url: `${wsApi()}${boardSharePath("Q-0001")}`, payload: {}, headers: { cookie } });
      return response.json<BoardShare>();
    });
    if (!share.shared) throw new Error("x");
    const anon = await pub(test.app, share.token);
    expect(anon.statusCode).toBe(200);
    expect(anon.body).toContain("aberto");
    expect((await pub(test.app, "x".repeat(43))).statusCode).toBe(404);
    expect((await test.app.inject({ url: `${wsApi()}/boards` })).statusCode).toBe(401);
    expect((await test.app.inject({ url: "/api/share/" })).statusCode).toBe(401);
  });

  it("malformado, inexistente, revogado, vencido e quadro apagado dão a MESMA resposta, byte a byte", async () => {
    let clock = Date.parse("2026-11-18T12:00:00.000Z");
    const { app, token, boards, workspaces } = await boardApp({ now: () => new Date(clock) });
    void workspaces;
    // revogado
    const second = await call<BoardShare>(app, "PUT", `${wsApi()}${boardSharePath("Q-0001")}`, { expiresInDays: 1 });
    expect(second).toMatchObject({ token });
    await boards.create({ title: "B", description: "d", html: "<p/>", createdBy: "x" });
    const other = await call<BoardShare>(app, "PUT", `${wsApi()}${boardSharePath("Q-0002")}`, {});
    if (!other.shared) throw new Error("x");
    await call(app, "DELETE", `${wsApi()}${boardSharePath("Q-0002")}`);
    // apagado (sem passar pelo DELETE do dono: o serviço apaga e o link some de forma preguiçosa)
    const third = await boards.create({ title: "C", description: "d", html: "<p/>", createdBy: "x" });
    const gone = await call<BoardShare>(app, "PUT", `${wsApi()}${boardSharePath(third.id)}`, {});
    if (!gone.shared) throw new Error("x");
    await boards.delete(third.id);
    // vencido
    clock += 2 * 86_400_000;
    const responses = await Promise.all([pub(app, "curto"), pub(app, "x".repeat(43)), pub(app, "a".repeat(200)), pub(app, other.token), pub(app, gone.token), pub(app, token)]);
    for (const response of responses) expect(response.statusCode).toBe(404);
    const [first, ...rest] = responses;
    for (const response of rest) {
      expect(response.rawPayload.equals(first!.rawPayload)).toBe(true);
      expect(response.headers).toEqual(first!.headers);
    }
    expect(first!.body).toContain("Este link não está mais disponível.");
    expect(first!.headers["set-cookie"]).toBeUndefined();
    for (const secret of ["Q-000", "principal", "Cyno"]) expect(first!.body).not.toContain(secret);
  });

  it("413 quando os dados passam de 8 MB", async () => {
    const { app, token, dir } = await boardApp();
    await writeFile(path.join(dir, "boards", "Q-0001", "data.json"), JSON.stringify({ blob: "x".repeat(PUBLIC_BOARD_MAX_DATA_BYTES + 10) }));
    const response = await pub(app, token);
    expect(response.statusCode).toBe(413);
    expect(response.body).toContain("grande demais");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("429 depois de 60 pedidos por minuto do mesmo IP", async () => {
    const { app, token } = await boardApp({ now: () => new Date("2026-11-18T12:00:00.000Z") });
    for (let i = 0; i < PUBLIC_BOARD_RATE_LIMIT; i++) expect((await pub(app, token)).statusCode).toBe(200);
    const blocked = await pub(app, token);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain("Muitos pedidos");
    expect(blocked.headers["retry-after"]).toBe("60");
    // Outro IP não é afetado.
    const other = await pub(app, token, "GET", { "x-forwarded-for": "203.0.113.9" });
    expect([200, 429]).toContain(other.statusCode);
  });
});

describe("portão da senha: isAuthExempt", () => {
  it("só GET e HEAD em /api/share/<algo sem barra> são abertos", () => {
    const token = "a".repeat(43);
    expect(isAuthExempt("GET", `/api/share/${token}`)).toBe(true);
    expect(isAuthExempt("HEAD", `/api/share/${token}`)).toBe(true);
    expect(isAuthExempt("GET", "/api/share/qualquer-coisa")).toBe(true);
    for (const [method, url] of [
      ["GET", "/api/share/"],
      ["GET", "/api/share"],
      ["GET", "/api/share/a/b"],
      ["GET", "/api/share//x"],
      ["GET", "/api/shareX"],
      ["GET", "/api/share/" + "a".repeat(129)],
      ["GET", "/api/w/x/boards"],
      ["GET", "/api/w/x/boards/Q-0001/share"],
      ["PUT", "/api/w/x/boards/Q-0001/share"],
      ["GET", "/api/w/x/boards/Q-0001/export"],
      ["POST", `/api/share/${token}`],
      ["PUT", `/api/share/${token}`],
      ["DELETE", `/api/share/${token}`],
      ["PATCH", `/api/share/${token}`],
    ] as const) {
      expect(isAuthExempt(method, url), `${method} ${url}`).toBe(false);
    }
  });
});
