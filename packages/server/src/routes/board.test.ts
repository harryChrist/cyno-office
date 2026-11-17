import type { Board } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

describe("API: quadros", () => {
  it("lista, detalhe, página, dados, PATCH e DELETE", async () => {
    const setup = await setupApp();
    const { app } = setup;
    const boards = setup.workspaces.get("principal").boards;
    expect(await call<Board[]>(app, "GET", `${wsApi()}/boards`)).toEqual([]);
    await boards.create({ title: "Obras", description: "Catálogo", html: "<script>alert(1)</script>", createdBy: "clara" });
    await boards.create({ title: "Estudos", description: "Concurso", html: "<p>e</p>", createdBy: "clara" });
    await boards.setData("Q-0001", { text: '{"works":{"w1":{"n":"A"}}}' });

    const list = await call<Board[]>(app, "GET", `${wsApi()}/boards`);
    expect(list.map((board) => board.id)).toEqual(["Q-0001", "Q-0002"]);
    expect(await call<Board>(app, "GET", `${wsApi()}/boards/Q-0001`)).toMatchObject({ title: "Obras", dataBytes: 26 });

    const page = await app.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/page` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/plain");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["content-security-policy"]).toBe("sandbox");
    expect(page.body).toBe("<script>alert(1)</script>");

    const data = await app.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/data` });
    expect(data.headers["content-type"]).toContain("application/json");
    expect(data.json()).toEqual({ works: { w1: { n: "A" } } });

    expect(await call<Board>(app, "PATCH", `${wsApi()}/boards/Q-0001`, { title: "Novo nome", description: "Outra" })).toMatchObject({ title: "Novo nome", description: "Outra" });
    expect((await app.inject({ method: "PATCH", url: `${wsApi()}/boards/Q-0001`, payload: { title: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `${wsApi()}/boards/Q-0001`, payload: { source: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/boards/Q-0099` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/boards/Q-0099/data` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/boards/xyz` })).statusCode).toBe(400);

    await call(app, "DELETE", `${wsApi()}/boards/Q-0001`);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/page` })).statusCode).toBe(404);
    expect((await call<Board[]>(app, "GET", `${wsApi()}/boards`)).map((board) => board.id)).toEqual(["Q-0002"]);
  });
});
