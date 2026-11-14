import type { Agent, Team, Room } from "./types";

/** Escritório mínimo e válido para testes de unidade. */
export function makeOffice(): { rooms: Room[]; teams: Team[]; agents: Agent[] } {
  return {
    rooms: [
      { id: "a", kind: "team", name: "A", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: ["b"] },
      { id: "b", kind: "team", name: "B", theme: "ocean", gridPosition: { x: 2, y: 0 }, readsGlobalBrain: false, readsBrainsOf: ["a"] },
    ],
    teams: [{ id: "a-time", roomId: "a", name: "Time", focus: "testar" }],
    agents: [
      {
        id: "ana",
        teamId: "a-time",
        name: "Ana",
        role: "Testadora",
        instructions: "Teste tudo.",
        avatar: { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" },
        status: "idle",
      },
    ],
  };
}
