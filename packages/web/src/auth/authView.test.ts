import { describe, expect, it } from "vitest";
import { blockedMessage, changePasswordErrorMessage, formatSetupCode, formatWait, gateFromStatus, loginErrorMessage, setupErrorMessage, validateNewPassword, validateSetup } from "./authView";

describe("authView", () => {
  it("gateFromStatus: só pede senha com senha definida e sem sessão", () => {
    expect(gateFromStatus({ enabled: false, authenticated: true })).toBe("ready");
    expect(gateFromStatus({ enabled: true, authenticated: false })).toBe("login");
    expect(gateFromStatus({ enabled: true, authenticated: true })).toBe("ready");
    expect(gateFromStatus({ enabled: false, authenticated: false, setupRequired: true })).toBe("setup");
  });

  it("tempo de bloqueio legível", () => {
    expect(formatWait(45)).toBe("45 s");
    expect(formatWait(14 * 60 + 32)).toBe("14 min 32 s");
    expect(formatWait(3600)).toBe("1 h");
    expect(formatWait(3600 + 5 * 60)).toBe("1 h 5 min");
    expect(blockedMessage(900)).toBe("Muitas tentativas erradas. Tente de novo em 15 min 00 s.");
    expect(blockedMessage(0)).toMatch(/espere/);
  });

  it("configuração inicial: formata o código e valida o formulário", () => {
    expect(formatSetupCode("abcd efgh-jkmn zz")).toBe("ABCD-EFGH-JKMN");
    expect(formatSetupCode("ab")).toBe("AB");
    expect(validateSetup("ABCD-EF", "senha-longa", "senha-longa")).toMatch(/código completo/);
    expect(validateSetup("ABCD-EFGH-JKMN", "", "")).toMatch(/Digite uma senha/);
    expect(validateSetup("ABCD-EFGH-JKMN", "123", "123")).toBeNull(); // sem tamanho mínimo
    expect(validateSetup("ABCD-EFGH-JKMN", "senha-longa", "outra-coisa")).toMatch(/iguais/);
    expect(validateSetup("ABCD-EFGH-JKMN", "senha-longa", "senha-longa")).toBeNull();
    // No desktop não há código: só a senha e a confirmação contam.
    expect(validateSetup("", "senha-longa", "senha-longa", false)).toBeNull();
    expect(validateSetup("", "curta", "curta", false)).toBeNull();
    expect(validateSetup("", "", "", false)).toMatch(/Digite uma senha/);
    expect(validateSetup("", "senha-longa", "outra-coisa", false)).toMatch(/iguais/);
    expect(setupErrorMessage(403, "x")).toMatch(/log do servidor/);
    expect(setupErrorMessage(400, "Dados inválidos")).toBe("Dados inválidos");
  });

  it("mensagens de login em pt-BR", () => {
    expect(loginErrorMessage(401)).toBe("Senha incorreta");
    expect(loginErrorMessage(429)).toBe("Muitas tentativas, espere alguns minutos");
    expect(loginErrorMessage(0)).toMatch(/servidor/);
    expect(loginErrorMessage(500)).toMatch(/problema/);
  });

  it("troca de senha: validação e erros", () => {
    expect(validateNewPassword("", "novasenha1", "novasenha1")).toMatch(/atual/);
    expect(validateNewPassword("velha", "", "")).toMatch(/Digite a nova senha/);
    expect(validateNewPassword("velha", "curta", "curta")).toBeNull(); // sem tamanho mínimo
    expect(validateNewPassword("velha", "novasenha1", "novasenha2")).toMatch(/iguais/);
    expect(validateNewPassword("velhasenha", "velhasenha", "velhasenha")).toMatch(/diferente/);
    expect(validateNewPassword("velha", "novasenha1", "novasenha1")).toBeNull();
    expect(changePasswordErrorMessage(403, "x")).toBe("A senha atual está incorreta");
    expect(changePasswordErrorMessage(400, "Dados inválidos")).toBe("Dados inválidos");
  });
});
