import { describe, expect, it } from "vitest";
import { parseServerEvent, parseServerMessage, SERVER_EVENT_TYPES, workspaceSocketPath } from "./events";

describe("parseServerEvent", () => {
  it("aceita eventos conhecidos", () => {
    const event = parseServerEvent(JSON.stringify({ type: "team:deleted", id: "projetox-backend" }));
    expect(event).toEqual({ type: "team:deleted", id: "projetox-backend" });
  });

  it("rejeita JSON inválido e tipos desconhecidos", () => {
    expect(parseServerEvent("{")).toBeNull();
    expect(parseServerEvent("null")).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: "toString" }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: "office:hack" }))).toBeNull();
  });

  it("lista todos os tipos de evento", () => {
    expect(SERVER_EVENT_TYPES).toHaveLength(51);
    expect(SERVER_EVENT_TYPES).toContain("board:upserted");
    expect(SERVER_EVENT_TYPES).toContain("board:deleted");
    expect(SERVER_EVENT_TYPES).toContain("library:upserted");
    expect(SERVER_EVENT_TYPES).toContain("library:deleted");
    expect(SERVER_EVENT_TYPES).toContain("library:app-run");
    for (const type of ["library:app", "library:app-removed", "library:job", "library:job-log"]) expect(SERVER_EVENT_TYPES).toContain(type);
    expect(SERVER_EVENT_TYPES).toContain("sync:resumed");
    expect(SERVER_EVENT_TYPES).toContain("usage:agents");
    expect(SERVER_EVENT_TYPES).toContain("system:warning");
    expect(SERVER_EVENT_TYPES).toContain("activity:appended");
    expect(SERVER_EVENT_TYPES).toContain("routine:upserted");
    expect(SERVER_EVENT_TYPES).toContain("routine:goal-hit");
    expect(SERVER_EVENT_TYPES).toContain("project:upserted");
    expect(SERVER_EVENT_TYPES).toContain("project:deleted");
    expect(SERVER_EVENT_TYPES).toContain("agent:log");
    expect(SERVER_EVENT_TYPES).toContain("agent:chat-status");
    expect(SERVER_EVENT_TYPES).toContain("agent:terminal");
    expect(SERVER_EVENT_TYPES).toContain("calendar:upserted");
    expect(SERVER_EVENT_TYPES).toContain("foryou:upserted");
    expect(SERVER_EVENT_TYPES).toContain("foryou:deleted");
    expect(SERVER_EVENT_TYPES).toContain("foryou-types:upserted");
    expect(SERVER_EVENT_TYPES).toContain("foryou-types:deleted");
    expect(SERVER_EVENT_TYPES).toContain("task:progress");
    expect(SERVER_EVENT_TYPES).toContain("workspaces:list");
    expect(SERVER_EVENT_TYPES).toContain("usage:updated");
    expect(SERVER_EVENT_TYPES).toContain("connector:upserted");
    expect(SERVER_EVENT_TYPES).toContain("connector:deleted");
    expect(SERVER_EVENT_TYPES).toContain("connector:activity");
    expect(SERVER_EVENT_TYPES).toContain("browser:tabs");
    expect(SERVER_EVENT_TYPES).toContain("browser:activity");
  });

  it("monta o caminho do WebSocket de um workspace", () => {
    expect(workspaceSocketPath("linkedin")).toBe("/ws?workspace=linkedin");
    expect(workspaceSocketPath("linkedin", null)).toBe("/ws?workspace=linkedin");
    expect(workspaceSocketPath("linkedin", { epoch: "a b", seq: 42 })).toBe("/ws?workspace=linkedin&since=42&epoch=a%20b");
  });
});

describe("parseServerMessage", () => {
  it("separa o seq do evento (o evento chega às stores sem ele)", () => {
    expect(parseServerMessage(JSON.stringify({ type: "team:deleted", id: "t1", seq: 7 }))).toEqual({ event: { type: "team:deleted", id: "t1" }, seq: 7 });
    expect(parseServerMessage(JSON.stringify({ type: "team:deleted", id: "t1" }))).toEqual({ event: { type: "team:deleted", id: "t1" } });
    expect(parseServerMessage(JSON.stringify({ type: "team:deleted", id: "t1", seq: "x" }))).toEqual({ event: { type: "team:deleted", id: "t1" } });
    expect(parseServerMessage("{")).toBeNull();
  });

  it("no snapshot, o seq é do retrato e fica no evento também", () => {
    const office = { rooms: [], teams: [], agents: [], tasks: [] };
    const message = parseServerMessage(JSON.stringify({ type: "office:snapshot", office, epoch: "e1", seq: 9 }));
    expect(message).toEqual({ event: { type: "office:snapshot", office, epoch: "e1", seq: 9 }, seq: 9 });
  });
});
