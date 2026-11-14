// A chave `?cena=demo` e os parâmetros do simulador. Arquivo sem dependências: o App o importa sem puxar o motor.

/** Parâmetros do simulador para o `?cena=demo`: 6 sessões e uma semente fixa (o mesmo escritório a cada abertura). */
export function parametrosDemo(search: string): string {
  const params = new URLSearchParams(search);
  const saida = new URLSearchParams();
  saida.set("sessions", params.get("sessions") ?? "6");
  saida.set("seed", params.get("seed") ?? "7");
  for (const chave of ["speed", "hora", "noquota"]) {
    const valor = params.get(chave);
    if (valor !== null) saida.set(chave, valor);
  }
  return `?${saida.toString()}`;
}

/** O endereço pede a cena de demonstração (`?cena=demo`)? */
export function pedeCenaDemo(search: string): boolean {
  return new URLSearchParams(search).get("cena") === "demo";
}
