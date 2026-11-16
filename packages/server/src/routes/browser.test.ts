import { describe, expect, it } from "vitest";
import { API, useTestApp } from "../dev/test-app";

describe("rotas do navegador compartilhado", () => {
  const setup = useTestApp();

  it("GET /browser: ligado, ainda fechado (sobe sob demanda) e sem abas", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: `${API}/browser` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true, running: false, tabs: [] });
  });

  it("POST /browser/tabs com endereço local ou file:// volta 400 sem abrir o Chromium", async () => {
    const { app, workspaces } = await setup();
    for (const url of ["http://127.0.0.1:3068", "file:///etc/passwd", "http://192.168.1.20:3067"]) {
      const response = await app.inject({ method: "POST", url: `${API}/browser/tabs`, payload: { url } });
      expect(response.statusCode, url).toBe(400);
    }
    expect(workspaces.get("principal").browser?.running).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `${API}/browser/tabs/t9` })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${API}/browser/tabs/../x` })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
