import type { AuthStatus } from "@cyno/shared";

/** Em que ponto está a entrada: consultando, pedindo senha ou liberado para abrir o app. */
export type GateState = "checking" | "setup" | "login" | "ready";

/** O que a tela deve fazer com a resposta de GET /api/auth/status. */
export function gateFromStatus(status: AuthStatus): GateState {
  if (status.setupRequired) return "setup";
  return status.enabled && !status.authenticated ? "login" : "ready";
}

/** "14 min 32 s", "1 h 5 min", "45 s": quanto falta para o IP ser liberado. */
export function formatWait(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** Texto do bloqueio por tentativas erradas, com o tempo que falta. */
export function blockedMessage(seconds: number): string {
  return seconds > 0 ? `Muitas tentativas erradas. Tente de novo em ${formatWait(seconds)}.` : "Muitas tentativas, espere alguns minutos";
}

/** Mensagem do erro de login, em pt-BR, a partir do status HTTP da resposta. */
export function loginErrorMessage(status: number): string {
  if (status === 401) return "Senha incorreta";
  if (status === 429) return "Muitas tentativas, espere alguns minutos";
  if (status === 0) return "Não foi possível falar com o servidor";
  if (status >= 500) return "O servidor teve um problema. Tente de novo.";
  return "Não foi possível entrar";
}

/** Erros de troca de senha: a senha atual errada vem como 403 (um 401 mandaria para a tela de login). */
export function changePasswordErrorMessage(status: number, serverMessage: string): string {
  if (status === 403) return "A senha atual está incorreta";
  if (status === 429) return "Muitas tentativas, espere alguns minutos";
  return serverMessage;
}

/** Valida o formulário de troca antes de enviar; devolve o erro ou null. */
export function validateNewPassword(current: string, next: string, repeat: string): string | null {
  if (!current) return "Digite a senha atual";
  if (next.length < 1) return "Digite a nova senha";
  if (next !== repeat) return "As duas senhas novas não são iguais";
  if (next === current) return "A nova senha precisa ser diferente da atual";
  return null;
}

/** Erro do segundo passo (código do app ou de recuperação). */
export function codeErrorMessage(status: number): string {
  if (status === 401) return "Código incorreto";
  if (status === 429) return "Muitas tentativas, espere alguns minutos";
  if (status === 0) return "Não foi possível falar com o servidor";
  return "Não foi possível entrar";
}

/** Valida a tela "Criar a senha": código (só quando o servidor exige), senha e confirmação. */
export function validateSetup(code: string, password: string, repeat: string, codeRequired = true): string | null {
  if (codeRequired && code.replace(/[^A-Za-z0-9]/g, "").length < 12) return "Digite o código completo que aparece no log do servidor";
  if (password.length < 1) return "Digite uma senha";
  if (password !== repeat) return "As duas senhas não são iguais";
  return null;
}

/** Erros da criação da senha. */
export function setupErrorMessage(status: number, serverMessage: string): string {
  if (status === 403) return "Código incorreto. Confira o código no log do servidor.";
  if (status === 429) return "Muitas tentativas, espere alguns minutos";
  if (status === 409) return "A senha já foi criada. Recarregue a página para entrar.";
  if (status === 0) return "Não foi possível falar com o servidor";
  return serverMessage;
}

/** Formata o código de configuração enquanto se digita: XXXX-XXXX-XXXX (maiúsculas, sem o que não é letra ou número). */
export function formatSetupCode(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return clean.replace(/(.{4})(?=.)/g, "$1-");
}

/** Códigos de 6 dígitos do app autenticador ou de recuperação (XXXXX-XXXXX): limpa espaços. */
export function cleanCode(input: string): string {
  return input.trim();
}
