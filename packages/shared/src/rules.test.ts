import { describe, expect, it } from "vitest";
import { findOfficeRuleViolations, gridKey, isLobbyCell } from "./rules";
import { makeOffice } from "./test-fixtures";

describe("findOfficeRuleViolations", () => {
  it("aceita um escritório válido", () => {
    expect(findOfficeRuleViolations(makeOffice())).toEqual([]);
  });

  it("Cérebros lidos: aceita lista não simétrica; recusa repetido, o próprio e inexistente", () => {
    const office = makeOffice();
    office.rooms[1]!.readsBrainsOf = [];
    expect(findOfficeRuleViolations(office)).toEqual([]);
    office.rooms[0]!.readsBrainsOf = ["b", "b", "a", "zzz"];
    const problems = findOfficeRuleViolations(office).join("\n");
    expect(problems).toMatch(/repete o Cérebro lido "b"/);
    expect(problems).toMatch(/próprio Cérebro/);
    expect(problems).toMatch(/inexistente "zzz"/);
  });

  it("detecta célula do lobby e células repetidas", () => {
    const office = makeOffice();
    office.rooms[0]!.gridPosition = { x: 0, y: 0 };
    office.rooms[1]!.gridPosition = { x: 0, y: 0 };
    const problems = findOfficeRuleViolations(office).join("\n");
    expect(problems).toMatch(/célula do lobby/);
    expect(problems).toMatch(/mesma célula/);
  });

  it("detecta ids repetidos, reservados e referências quebradas", () => {
    const office = makeOffice();
    office.rooms[1]!.id = "lobby";
    office.teams.push({ ...office.teams[0]! });
    office.agents[0]!.teamId = "nao-existe";
    const problems = findOfficeRuleViolations(office).join("\n");
    expect(problems).toMatch(/id reservado/);
    expect(problems).toMatch(/id repetido: "a-time"/);
    expect(problems).toMatch(/time inexistente/);
  });
});

describe("grid", () => {
  it("identifica a célula do lobby", () => {
    expect(isLobbyCell({ x: 0, y: 0 })).toBe(true);
    expect(isLobbyCell({ x: 1, y: 0 })).toBe(false);
    expect(gridKey({ x: -1, y: 2 })).toBe("-1,2");
  });
});
