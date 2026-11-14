import type { OneShotAccount, OneShotEngineId } from "@cyno/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * A forma de conta (chave do painel ou configuração do próprio programa) de um motor de um processo por turno, lida do
 * estado dos motores ao montar (sem cache: quem troca a conta em Configurações vê o seletor certo ao voltar).
 * Enquanto carrega, ou se o servidor não responde, vale a chave do painel (o padrão).
 */
export function useEngineAccount(engine: OneShotEngineId): OneShotAccount | undefined {
  const [account, setAccount] = useState<OneShotAccount | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.getEngineStatus().then(
      (response) => {
        if (alive) setAccount(response.engines.find((candidate) => candidate.id === engine)?.account);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [engine]);
  return account;
}
