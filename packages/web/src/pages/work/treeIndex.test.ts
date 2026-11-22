import { childrenOf, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { ancestorsIn, depthIn, heightIn, isLeafIn, kidsOf, moveDependencyConflict, subtreeSet, treeIndex } from "./treeIndex";

const AT = "2026-11-10T12:00:00.000Z";
const node = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Item ${ref}`,
  briefing: "",
  ownerId: "",
  steps: [],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "backlog",
  updatedAt: AT,
  ...extra,
});

/** M > N > (a, b); M > c; z solta. `order` de propósito fora da ordem da lista. */
const tasks = [node("M", { group: true }), node("c", { parent: "M", order: 3000 }), node("N", { parent: "M", group: true, order: 1000 }), node("b", { parent: "N", order: 2000 }), node("a", { parent: "N", order: 1000 }), node("z")];

describe("treeIndex", () => {
  it("os filhos saem na mesma ordem do childrenOf do shared", () => {
    const index = treeIndex(tasks);
    for (const parent of [undefined, "M", "N", "a"]) expect(kidsOf(index, parent).map((task) => task.ref)).toEqual(childrenOf({ tasks }, parent).map((task) => task.ref));
  });

  it("subárvore, altura, profundidade e ancestrais", () => {
    const index = treeIndex(tasks);
    expect([...subtreeSet(index, "M")].sort()).toEqual(["M", "N", "a", "b", "c"]);
    expect(heightIn(index, "M")).toBe(3);
    expect(heightIn(index, "z")).toBe(1);
    expect(depthIn(index, "a")).toBe(3);
    expect(ancestorsIn(index, "a").map((task) => task.ref)).toEqual(["N", "M"]);
    expect(isLeafIn(index, tasks[0]!)).toBe(false);
    expect(isLeafIn(index, tasks[5]!)).toBe(true);
  });

  it("tolera ciclo nos dados (não trava)", () => {
    const loop = [node("x", { parent: "y" }), node("y", { parent: "x" })];
    const index = treeIndex(loop);
    expect(depthIn(index, "x")).toBe(2);
    expect(ancestorsIn(index, "x").map((task) => task.ref)).toEqual(["y"]);
  });

  it("conflito de dependência ao mover: ancestral que espera o movido, e o movido que espera um ancestral", () => {
    const base = [node("M", { group: true, dependsOn: ["z"] }), node("z"), node("w", { dependsOn: ["M"] })];
    const index = treeIndex(base);
    expect(moveDependencyConflict(index, "z", "M")).toContain("espera");
    expect(moveDependencyConflict(index, "w", "M")).toContain("espera");
    expect(moveDependencyConflict(index, "z", undefined)).toBeNull();
    expect(moveDependencyConflict(treeIndex([node("M", { group: true }), node("z")]), "z", "M")).toBeNull();
  });
});
