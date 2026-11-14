import { describe, expect, it } from "vitest";
import { maskSecrets } from "./secrets";
import { PUSH_BODY_MAX, pushPayloadForAlert, pushPayloadForBatch, pushSubscribeBodySchema, pushUrlFor } from "./push";

describe("push: corpo da inscrição", () => {
  const keys = { p256dh: "p", auth: "a" };
  it("aceita https e ignora expirationTime; recusa http, sem chaves e campos extras", () => {
    expect(pushSubscribeBodySchema.safeParse({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys, expirationTime: null }, name: " Meu celular " }).data?.name).toBe("Meu celular");
    expect(pushSubscribeBodySchema.safeParse({ subscription: { endpoint: "http://x.test/a", keys } }).success).toBe(false);
    expect(pushSubscribeBodySchema.safeParse({ subscription: { endpoint: "https://x.test/a" } }).success).toBe(false);
    expect(pushSubscribeBodySchema.safeParse({ subscription: { endpoint: "https://x.test/a", keys }, extra: 1 }).success).toBe(false);
  });
});

describe("push: conteúdo do aviso", () => {
  it("uma linha, curto, mascarado, com o workspace e o destino", () => {
    const secret = `ghp_${"b".repeat(36)}`;
    const payload = pushPayloadForAlert({ key: "approval:p:1", text: `Colar ${secret}\nresto ${"y".repeat(400)}`, workspaceName: "Loja" }, maskSecrets);
    expect(payload.body).not.toContain(secret);
    expect(payload.body).not.toContain("resto");
    expect(payload.body.endsWith(" · Loja")).toBe(true);
    expect(payload.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX + 50);
    expect(payload).toMatchObject({ tag: "approval:p:1", url: pushUrlFor("approval:p:1"), kind: "alert" });
  });

  it("lote: soma os itens e nomeia o workspace só se for um", () => {
    expect(pushPayloadForBatch([{ count: 2, workspaceName: "A" }, { count: 1, workspaceName: "A" }]).body).toBe("3 coisas esperando você · A");
    expect(pushPayloadForBatch([{ count: 1 }, { count: 1 }]).body).toBe("2 coisas esperando você");
    expect(pushPayloadForBatch([{ count: 1, workspaceName: "A" }]).body).toBe("1 coisa esperando você · A");
  });
});
