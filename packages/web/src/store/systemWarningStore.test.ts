import { beforeEach, describe, expect, it } from "vitest";
import { useSystemWarningStore } from "./systemWarningStore";

const AT = "2026-11-11T12:00:00.000Z";

describe("systemWarningStore", () => {
  beforeEach(() => useSystemWarningStore.setState({ warnings: [] }));

  it("empilha avisos, não repete o mesmo texto e guarda só os 3 mais novos", () => {
    const { push } = useSystemWarningStore.getState();
    push("a", AT);
    push("a", AT);
    push("b", AT);
    push("c", AT);
    push("d", AT);
    expect(useSystemWarningStore.getState().warnings.map((warning) => warning.message)).toEqual(["b", "c", "d"]);
  });

  it("dispensar tira só o aviso escolhido", () => {
    const { push } = useSystemWarningStore.getState();
    push("a", AT);
    push("b", AT);
    const [first] = useSystemWarningStore.getState().warnings;
    useSystemWarningStore.getState().dismiss(first!.id);
    expect(useSystemWarningStore.getState().warnings.map((warning) => warning.message)).toEqual(["b"]);
  });
});
