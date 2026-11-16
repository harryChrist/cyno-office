import { PALETTE, type Avatar } from "../index";
import type { AppearanceParts } from "@cyno/cena/tipos";

const PELE: Record<string, string> = { tone1: "skin-1", tone2: "skin-2", tone3: "skin-3", tone4: "skin-4", tone5: "skin-5", tone6: "skin-6" };

const CABELO: Record<string, NonNullable<AppearanceParts["hairStyle"]>> = {
  short: "short",
  long: "long",
  curly: "curly",
  buzz: "buzz",
  bun: "bun",
  mohawk: "mohawk",
  bald: "bald",
  ponytail: "ponytail",
};

/** `scarf` não existe no motor: vira sem acessório (perda mínima, prevista no plano). */
const ACESSORIO: Record<string, NonNullable<AppearanceParts["accessory"]>> = {
  glasses: "glasses",
  headphones: "headphones",
  cap: "cap",
  earring: "earrings",
  scarf: "none",
};

const cor = (id: string): string | undefined => (PALETTE as Record<string, string>)[id];

/** `look` do personagem: o bit da semente, ajustado por cabelo comprido (só enviesa o sorteio das peças não definidas). */
export function parecenca(avatar: Pick<Avatar, "hair">, bit: number): "f" | "m" {
  if (avatar.hair === "long" || avatar.hair === "ponytail" || avatar.hair === "bun") return "f";
  return bit === 0 ? "m" : "f";
}

/** O avatar do Cyno (cores nomeadas da paleta) nas peças do motor (cores em #rrggbb). Peças ausentes vêm da semente. */
export function avatarParaPartes(avatar: Avatar): AppearanceParts {
  const partes: AppearanceParts = {};
  const pele = PELE[avatar.skin];
  const peleCor = pele ? cor(pele) : undefined;
  if (peleCor) partes.skin = peleCor;
  // As peças do motor escolhidas no editor (`avatar.cena`) valem por cima dos campos antigos.
  const estilo = (avatar.cena?.hairStyle as AppearanceParts["hairStyle"] | undefined) ?? CABELO[avatar.hair];
  if (estilo) partes.hairStyle = estilo;
  if (avatar.cena?.topStyle) partes.topStyle = avatar.cena.topStyle as AppearanceParts["topStyle"];
  const cabelo = cor(avatar.hairColor);
  if (cabelo) partes.hair = cabelo;
  const camisa = cor(avatar.shirt);
  if (camisa) partes.top = camisa;
  const calca = cor(avatar.pants);
  if (calca) partes.bottom = calca;
  const acessorio = (avatar.cena?.accessory as AppearanceParts["accessory"] | undefined) ?? (avatar.accessory ? ACESSORIO[avatar.accessory] : undefined);
  if (acessorio) partes.accessory = acessorio;
  return partes;
}

/** O Maestro tem visual fixo: camisa social azul-marinho e fone; pele e cabelo continuam os do avatar dele. */
export function partesDoMaestro(avatar: Avatar): AppearanceParts {
  return { ...avatarParaPartes(avatar), top: "#1f2a44", topStyle: "shirt_tie", accessory: "headphones" };
}
