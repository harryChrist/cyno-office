import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "./authStore";
import { LoginScreen } from "./LoginScreen";
import { SetupScreen } from "./SetupScreen";

/**
 * Porta do app: consulta /api/auth/status antes de tudo. Com senha e sem sessão mostra o login em
 * tela cheia; só com a sessão válida (ou sem senha) monta o app (e com ele o WebSocket e os stores).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const gate = useAuthStore((state) => state.gate);
  useEffect(() => {
    void useAuthStore.getState().boot();
  }, []);
  if (gate === "checking") return null;
  if (gate === "setup") return <SetupScreen />;
  if (gate === "login") return <LoginScreen />;
  return <>{children}</>;
}
