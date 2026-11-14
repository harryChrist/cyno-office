import { describe, expect, it } from "vitest";
import { cynoPetPose } from "./petPose";

describe("cynoPetPose", () => {
  it("dorme de olhos fechados, com o z e mais apagado (sem estado também)", () => {
    for (const status of ["sleeping", undefined] as const) {
      const pose = cynoPetPose(status);
      expect(pose).toMatchObject({ name: "sleeping", eyesClosed: true, zzz: true, dim: true, blinking: false, tailWag: false });
    }
  });

  it("trabalhando e acordando: orelhas em pé, rabo balançando e respirando", () => {
    for (const status of ["working", "waking"] as const) {
      expect(cynoPetPose(status)).toMatchObject({ name: "working", earsUp: true, tailWag: true, breathing: true, eyesClosed: false, zzz: false });
    }
  });

  it("acordado e parado: olhos abertos e piscando", () => {
    expect(cynoPetPose("awake")).toMatchObject({ name: "idle", eyesClosed: false, blinking: true, tilted: false, dim: false });
  });

  it("esperando você: inclina a cabeça, mas não enquanto dorme nem trabalha", () => {
    expect(cynoPetPose("awake", true)).toMatchObject({ name: "waiting", tilted: true });
    expect(cynoPetPose("sleeping", true).tilted).toBe(false);
    expect(cynoPetPose("working", true).tilted).toBe(false);
  });
});
