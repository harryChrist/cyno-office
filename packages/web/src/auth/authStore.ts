import type { AuthStatus } from "@cyno/shared";
import { AUTH_STATUS_PATH } from "@cyno/shared";
import { create } from "zustand";
import { gateFromStatus, type GateState } from "./authView";

type AuthState = {
  gate: GateState;
  /** Há senha definida no servidor? (as Configurações mostram o estado.) */
  enabled: boolean;
  /** A sessão caiu com o app aberto (a tela de login avisa e recarrega depois de entrar). */
  expired: boolean;
  /** Consulta /api/auth/status; sem resposta (servidor fora), deixa o app abrir como antes. */
  boot: () => Promise<void>;
  /** Qualquer 401 da API ou do WebSocket: volta para o login. */
  expire: () => void;
  /** Login feito. */
  loggedIn: () => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  gate: "checking",
  enabled: false,
  expired: false,
  boot: async () => {
    try {
      const response = await fetch(AUTH_STATUS_PATH, { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) return set({ gate: "ready" });
      const status = (await response.json()) as AuthStatus;
      set({ gate: gateFromStatus(status), enabled: status.enabled });
    } catch {
      set({ gate: "ready" });
    }
  },
  expire: () => {
    if (get().gate === "ready") set({ gate: "login", enabled: true, expired: true });
  },
  loggedIn: () => set({ gate: "ready", enabled: true }),
}));

let lastCheck = 0;
/**
 * Um WebSocket caiu sem abrir: pode ser a sessão (o upgrade volta 401 sem corpo legível pelo
 * navegador). Pergunta ao servidor; se a sessão morreu, vai para o login. No máximo uma vez por 5 s.
 */
export async function checkSessionAfterDrop(): Promise<void> {
  const now = Date.now();
  if (now - lastCheck < 5000 || useAuthStore.getState().gate !== "ready") return;
  lastCheck = now;
  try {
    const response = await fetch(AUTH_STATUS_PATH, { cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) return;
    const status = (await response.json()) as AuthStatus;
    if (gateFromStatus(status) === "login") useAuthStore.getState().expire();
  } catch {
    // Servidor fora: não é a sessão.
  }
}
