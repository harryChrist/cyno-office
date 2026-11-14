import { maestroSessionName, type AgentTerminalInfo, type Workspace } from "@cyno/shared";

/** Onde abrir a sessão quando a CLI ainda não mostrou o link dela. */
export const CLAUDE_CODE_WEB = "https://claude.ai/code";

/** O que o selo do Remote Control mostra (função pura, testada). */
export function remoteControlView(info: AgentTerminalInfo | undefined): { state: "active" | "waiting" | "off"; label: string; name?: string; href: string; hint: string } | null {
  if (info?.mode !== "pty") return null;
  const remote = info.remote;
  if (!remote) return { state: "off", label: "Remote Control desligado", href: CLAUDE_CODE_WEB, hint: "Ligue com MAESTRO_REMOTE_CONTROL=1 no server." };
  if (remote.active && (info.status === "idle" || info.status === "busy" || info.status === "starting")) {
    return {
      state: "active",
      label: "Remote Control: ativo",
      ...(remote.name ? { name: remote.name } : {}),
      href: remote.url ?? CLAUDE_CODE_WEB,
      hint: `Abra no app do Claude ou em claude.ai/code${remote.name ? ` (sessão “${remote.name}”)` : ""}: é esta mesma conversa.`,
    };
  }
  return {
    state: "waiting",
    label: info.status === "stopped" || info.status === "error" ? "Remote Control: fora (terminal parado)" : "Remote Control: conectando…",
    ...(remote.name ? { name: remote.name } : {}),
    href: CLAUDE_CODE_WEB,
    hint: "Fica disponível quando o terminal do Maestro estiver de pé.",
  };
}

/** O que o cabeçalho do Maestro mostra do Remote Control: estado, nome da sessão e o que falta aplicar. */
export type RemoteSessionView = {
  state: "active" | "waiting" | "off";
  /** "ligado", "conectando…", "fora (terminal parado)", "desligado". */
  stateLabel: string;
  /** O nome em uso (o da sessão viva, se há; senão o configurado). */
  name: string;
  /** Nome novo esperando o Maestro ficar livre (`/rename`). */
  pending?: string;
  href: string;
  hint: string;
};

/** Pura (testada): o selo do Remote Control com o nome da sessão. Null = o Maestro não roda num terminal. */
export function remoteSessionView(info: AgentTerminalInfo | undefined, workspace: Pick<Workspace, "name" | "maestro"> | undefined): RemoteSessionView | null {
  const view = remoteControlView(info);
  if (!view) return null;
  const configured = workspace ? maestroSessionName(workspace.maestro, workspace.name) : undefined;
  const name = info?.remote?.name ?? configured ?? "";
  const stateLabel = view.state === "active" ? "ligado" : view.state === "off" ? "desligado" : view.label.replace(/^Remote Control: /, "");
  const pending = info?.remote?.pendingName;
  return { state: view.state, stateLabel, name, ...(pending && pending !== name ? { pending } : {}), href: view.href, hint: view.hint };
}
