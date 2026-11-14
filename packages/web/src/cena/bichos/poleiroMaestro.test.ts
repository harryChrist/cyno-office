// O poleiro da calopsita na Sala do Maestro nova: na ponta direita do tampo da mesa de chefe (com a preferência
// "ao lado do Maestro") e, sem ela, no balcão da recepção. A planta é a real do motor.
import { TILE } from "@cyno/cena/arte";
import type { WorldProbe } from "@cyno/cena";
import { describe, expect, it } from "vitest";
import { layoutProjectRoom } from "../../../../cena/client/src/world/layout/room";
import { portaDoMotor } from "./porta";

const tema = { carpet: "#4f6d8f", carpet2: "#486685", wall: { base: "#e6e2da", trim: "#9a8f80", pattern: "plain" as const }, accent: "#3f7fd8", deskVariant: "wood", chairVariant: "black" };
const sala = layoutProjectRoom({ id: "sala-do-maestro", slot: 0, seed: 7, kind: "maestro" }, tema);
const recepcao = { id: "recepcao", kind: "reception", rect: { x: 0, y: 0, w: 16, h: 12 }, rugs: [], furniture: [{ id: "r", kind: "reception_desk", tx: 5, ty: 4 }] };
const sonda = (areas: unknown[]) => ({ sim: { building: { core: [recepcao], rooms: areas } } }) as unknown as WorldProbe;

describe("poleiro da calopsita (planta nova)", () => {
  it("com a preferência: na ponta direita do tampo da mesa de chefe, em cima dela", () => {
    const p = portaDoMotor(() => sonda([sala])).poleiro(true)!;
    const mesa = sala.furniture.find((f) => f.kind === "boss_desk")!;
    const direita = (mesa.tx + 4) * TILE;
    expect(p.onde).toBe("maestro");
    expect(p.x).toBeGreaterThan(direita - 16);
    expect(p.x).toBeLessThan(direita);
    // pisa no tampo (dentro da altura da mesa) e é desenhada depois da mesa
    expect(p.y).toBeGreaterThan(mesa.ty * TILE);
    expect(p.y).toBeLessThan((mesa.ty + 1) * TILE);
    expect(p.profundidade).toBe((mesa.ty + 1) * TILE + 1);
  });

  it("sem a preferência: o poleiro vai para o balcão da recepção, não para a sala dele", () => {
    const p = portaDoMotor(() => sonda([sala])).poleiro(false)!;
    expect(p.onde).toBe("recepcao");
    expect(p.x).toBeLessThan(sala.rect.x * TILE);
  });

  it("sem a sala do Maestro no prédio, mesmo com a preferência ele cai na recepção", () => {
    const p = portaDoMotor(() => sonda([])).poleiro(true)!;
    expect(p.onde).toBe("recepcao");
  });

  it("sala do Maestro de planta antiga (com mesas de time) ainda acha onde pousar", () => {
    const antiga = { id: "sala-do-maestro", kind: "room", rect: sala.rect, rugs: [], furniture: [{ id: "d", kind: "desk", tx: 8, ty: 6 }] };
    expect(portaDoMotor(() => sonda([antiga])).poleiro(true)!.onde).toBe("maestro");
  });
});
