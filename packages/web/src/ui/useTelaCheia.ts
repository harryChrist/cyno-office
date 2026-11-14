import { useCallback, useEffect, useRef, useState } from "react";
import { aoMudarTelaCheiaDoNavegador, entrarNaTelaCheia, escSaiDaTelaCheia, sairDaTelaCheia, TELA_CHEIA_FECHADA, type EstadoTelaCheia } from "./telaCheia";

/**
 * Gancho da tela cheia (a cidade e o Escritório usam o mesmo): `ativa`, `alternar` e `sair`. Entra pela API do
 * navegador quando existe e é aceita; senão é só a camada fixa (quem usa o gancho põe a classe CSS quando `ativa`).
 * Esc e o botão saem; o navegador saindo sozinho (Esc na nativa) também. `classeNaRaiz` (opcional) é posta no
 * `<html>` enquanto ativa, para esconder o menu e os painéis por CSS. Ao sair, devolve o foco a `focoAoSair`.
 */
export function useTelaCheia(opcoes: { classeNaRaiz?: string; focoAoSair?: () => HTMLElement | null } = {}) {
  const [estado, setEstado] = useState<EstadoTelaCheia>(TELA_CHEIA_FECHADA);
  const estadoRef = useRef(estado);
  const opcoesRef = useRef(opcoes);
  useEffect(() => {
    estadoRef.current = estado;
    opcoesRef.current = opcoes;
  });

  const devolverFoco = useCallback(() => {
    requestAnimationFrame(() => opcoesRef.current.focoAoSair?.()?.focus());
  }, []);

  const sair = useCallback(async () => {
    const proximo = await sairDaTelaCheia(document, estadoRef.current);
    estadoRef.current = proximo;
    setEstado(proximo);
    devolverFoco();
  }, [devolverFoco]);

  const alternar = useCallback(async () => {
    if (estadoRef.current.ativa) return sair();
    const proximo = await entrarNaTelaCheia(document);
    estadoRef.current = proximo;
    setEstado(proximo);
  }, [sair]);

  useEffect(() => {
    if (!estado.ativa) return;
    const teclado = (evento: KeyboardEvent) => {
      if (evento.defaultPrevented) return;
      if (escSaiDaTelaCheia(estadoRef.current, evento.key, document.querySelector("dialog[open]") !== null)) void sair();
    };
    const mudou = () => {
      const proximo = aoMudarTelaCheiaDoNavegador(estadoRef.current, document);
      if (proximo !== estadoRef.current) {
        estadoRef.current = proximo;
        setEstado(proximo);
        devolverFoco();
      }
    };
    window.addEventListener("keydown", teclado);
    document.addEventListener("fullscreenchange", mudou);
    return () => {
      window.removeEventListener("keydown", teclado);
      document.removeEventListener("fullscreenchange", mudou);
    };
  }, [estado.ativa, sair, devolverFoco]);

  const classe = opcoes.classeNaRaiz;
  useEffect(() => {
    if (!estado.ativa || !classe) return;
    document.documentElement.classList.add(classe);
    return () => document.documentElement.classList.remove(classe);
  }, [estado.ativa, classe]);

  // Desmontou em tela cheia (trocou de página): fecha a nativa para não ficar presa.
  useEffect(
    () => () => {
      if (estadoRef.current.modo === "nativa" && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    },
    [],
  );

  return { ativa: estado.ativa, modo: estado.modo, alternar, sair };
}
