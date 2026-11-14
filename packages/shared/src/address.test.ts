import { describe, expect, it } from "vitest";
import { agentAddress, parseAddress } from "./address";

describe("endereço do agente", () => {
  it("monta workspace/agente e lê de volta", () => {
    expect(agentAddress("linkedin", "eco")).toBe("linkedin/eco");
    expect(parseAddress("linkedin/eco")).toEqual({ workspace: "linkedin", agentId: "eco" });
    expect(parseAddress(" linkedin/maestro ")).toEqual({ workspace: "linkedin", agentId: "maestro" });
  });

  it("recusa formas inválidas", () => {
    for (const bad of ["eco", "a/b/c", "/eco", "linkedin/", "Linkedin/eco", ""]) expect(parseAddress(bad)).toBeUndefined();
  });
});
