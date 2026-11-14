import { describe, expect, it } from "vitest";
import original from "../../cena/LICENSE?raw";
import servida from "../public/licencas/cena-LICENSE.txt?raw";

// O motor de cena e a arte vêm de um projeto MIT; a licença exige o aviso nas cópias. O `vite build` tira os comentários
// do código, então o texto também é servido pelo site num endereço fixo (`/licencas/cena-LICENSE.txt`, com link em
// Configurações > Aparência). Esta conferência impede que a cópia servida e o original divirjam.
describe("aviso de licença do motor de cena", () => {
  it("o arquivo servido pelo site é igual ao LICENSE do pacote", () => {
    expect(servida).toBe(original);
  });

  it("traz o aviso de copyright e a permissão do MIT", () => {
    expect(servida).toContain("MIT License");
    expect(servida).toContain("Copyright (c) 2026 Márcio Junior");
    expect(servida).toContain("The above copyright notice and this permission notice shall be included in all");
  });
});
