// A arte do motor de cena (personagens e cores dos temas) para os painéis e formulários do Cyno: baixada uma vez,
// sob demanda (o mesmo pedaço que a cena usa), sem pôr o motor inteiro no pacote principal.
import { useEffect, useState } from "react";

export type ArteDoMotor = typeof import("@cyno/cena/arte");

let arte: ArteDoMotor | null = null;
let carregando: Promise<ArteDoMotor> | null = null;

export function arteCarregada(): ArteDoMotor | null {
  return arte;
}

export function carregarArte(): Promise<ArteDoMotor> {
  carregando ??= import("@cyno/cena/arte").then((modulo) => (arte = modulo));
  return carregando;
}

/** A arte do motor, ou null até ela chegar (o componente se redesenha quando chega). */
export function useArteDoMotor(): ArteDoMotor | null {
  const [pronta, setPronta] = useState(arte);
  useEffect(() => {
    if (arte) return;
    let vivo = true;
    void carregarArte().then((modulo) => vivo && setPronta(modulo));
    return () => {
      vivo = false;
    };
  }, []);
  return pronta;
}
