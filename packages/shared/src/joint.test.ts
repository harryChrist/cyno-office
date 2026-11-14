import { describe, expect, it } from "vitest";
import { JOINT_EVENT_TYPES, jointMarker, jointProjectSchema, parseJointMarker } from "./joint";
import { CYNO_EVENT_TYPES, parseCynoEvent } from "./cyno";

const AT = "2026-11-11T12:00:00.000Z";

describe("projeto conjunto (shared)", () => {
  it("a marca do cartão ida e volta, e texto comum não vira cartão", () => {
    expect(parseJointMarker(jointMarker("J-0003", "Post  com\narte"))).toEqual({ jointId: "J-0003", title: "Post com arte" });
    expect(parseJointMarker("[[pedido:ws:abc]] x")).toBeUndefined();
    expect(parseJointMarker("Projeto conjunto concluído")).toBeUndefined();
  });

  it("o registro novo lê arquivos antigos (campos novos opcionais) e aceita os estados novos", () => {
    const parsed = jointProjectSchema.parse({
      id: "J-0001",
      title: "T",
      brief: "",
      createdAt: AT,
      parts: [
        { ref: "P1", workspace: "design", title: "A", briefing: "B", status: "concluida", summary: "feito", deliverables: ["M-0001"] },
        { ref: "P2", workspace: "posts", title: "C", briefing: "D", dependsOn: ["P1"], status: "bloqueada", blockedReason: "Waits for part P1" },
      ],
    });
    expect(parsed.parts[1]).toMatchObject({ status: "bloqueada", dependsOn: ["P1"] });
    expect(parsed.paused).toBeUndefined();
  });

  it("o evento do conjunto é um evento do websocket do Cyno", () => {
    expect(CYNO_EVENT_TYPES).toEqual(expect.arrayContaining([...JOINT_EVENT_TYPES]));
    expect(parseCynoEvent({ type: "cyno:joints", joints: [] })).toEqual({ type: "cyno:joints", joints: [] });
  });
});
