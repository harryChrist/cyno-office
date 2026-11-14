import type { RoomThemeId } from "@cyno/shared";

/**
 * Os temas que o motor tem (índice de `art.roomTheme`), cada um com o id do Cyno que o representa e um nome.
 * O seletor de tema mostra só estes dez; os ids antigos (`forest`, `night`, `sunset`, `industrial`, `office`) seguem
 * valendo nos dados e caem no índice do mapa em `temas.ts`.
 */
export const TEMAS_DO_MOTOR: readonly { indice: number; id: RoomThemeId; nome: string }[] = [
  { indice: 0, id: "snow", nome: "Azul-cinza" },
  { indice: 1, id: "sand", nome: "Areia" },
  { indice: 2, id: "mint", nome: "Verde-sálvia" },
  { indice: 3, id: "lavender", nome: "Lilás" },
  { indice: 4, id: "terracotta", nome: "Terracota" },
  { indice: 5, id: "cyber", nome: "Água" },
  { indice: 6, id: "graphite", nome: "Cinza-tijolo" },
  { indice: 7, id: "cherry", nome: "Rosa" },
  { indice: 8, id: "ocean", nome: "Azul-gelo" },
  { indice: 9, id: "coffee", nome: "Madeira" },
];

/** Nome do tema no motor para um id do Cyno (ids antigos caem no tema do motor que os representa). */
export function nomeDoTemaNoMotor(indice: number): string {
  return TEMAS_DO_MOTOR[indice]?.nome ?? TEMAS_DO_MOTOR[0]!.nome;
}
