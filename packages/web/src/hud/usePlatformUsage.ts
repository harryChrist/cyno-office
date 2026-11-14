import { useEffect } from "react";
import { api } from "../api/client";
import { useUsageStore } from "../store/usageStore";

/** De quanto em quanto tempo a página da plataforma pede o uso da conta (o server limita a 1 consulta real a cada 30 s). */
export const PLATFORM_USAGE_POLL_MS = 120_000;

/** Pede ao server o uso atual de cada motor e joga no store (consulta desligada ou falha: ignora, fica o que já havia). */
export async function pullPlatformUsage(): Promise<void> {
  await Promise.all(
    (["claude", "gemini"] as const).map(async (provider) => {
      try {
        const result = await api.refreshUsage(provider);
        if (result.usage) useUsageStore.getState().apply({ type: "usage:updated", usage: result.usage });
      } catch {
        // 503 (consulta desligada) ou rede fora: o anel mostra o último dado conhecido.
      }
    }),
  );
}

/**
 * O uso da assinatura é da conta, mas o store só é alimentado pelo socket de um workspace. Nas
 * páginas da plataforma (sem workspace aberto) este hook busca o uso ao entrar e de tempos em
 * tempos (só com a aba visível), reaproveitando a mesma rota do botão "atualizar" do anel.
 */
export function usePlatformUsage(): void {
  useEffect(() => {
    void pullPlatformUsage();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void pullPlatformUsage();
    }, PLATFORM_USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
