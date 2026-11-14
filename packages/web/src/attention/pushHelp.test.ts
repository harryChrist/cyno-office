import { describe, expect, it } from "vitest";
import { PUSH_OPTIONAL_NOTE, pushDeviceKind, pushHelpFor } from "./pushHelp";

const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

describe("pushDeviceKind", () => {
  it("reconhece Chrome no Android, iPhone e computador", () => {
    expect(pushDeviceKind(ANDROID_CHROME)).toBe("android-chrome");
    expect(pushDeviceKind(IPHONE)).toBe("iphone-safari");
    expect(pushDeviceKind(DESKTOP)).toBe("desktop");
  });
  it("outros navegadores do Android e textos desconhecidos recebem o texto geral", () => {
    expect(pushDeviceKind("Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0")).toBe("other");
    expect(pushDeviceKind("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 SamsungBrowser/25.0 Mobile Safari/537.36")).toBe("other");
    expect(pushDeviceKind("")).toBe("other");
  });
});

describe("pushHelpFor", () => {
  it("Chrome no Android: os três passos, o que é 'bloqueada automaticamente' e o aviso de aba anônima", () => {
    const help = pushHelpFor("android-chrome");
    const text = help.steps.join("\n");
    expect(text).toContain("Configurações, Apps, Chrome, Notificações");
    expect(text).toContain("Usar mensagens mais silenciosas");
    expect(text).toContain("Bloqueados");
    expect(text).toContain("Limpar e redefinir");
    expect(text).toContain("sininho riscado");
    expect(text).toContain("aba anônima");
    expect(help.why).toContain("Bloqueada automaticamente");
  });
  it("iPhone manda adicionar à tela de início; computador manda ao cadeado; os outros recebem o geral", () => {
    expect(pushHelpFor("iphone-safari").steps.join(" ")).toContain("Tela de Início");
    expect(pushHelpFor("desktop").steps.join(" ")).toContain("cadeado");
    expect(pushHelpFor("other").title).toBe("Como liberar as notificações");
  });
  it("nenhum texto promete que o site se desbloqueia sozinho, e dizer que é opcional vem à parte", () => {
    for (const kind of ["android-chrome", "iphone-safari", "desktop", "other"] as const) expect(pushHelpFor(kind).steps.join(" ")).not.toMatch(/desbloque(ar|amos) (sozinho|automaticamente)/i);
    expect(PUSH_OPTIONAL_NOTE).toContain("opcional");
    expect(PUSH_OPTIONAL_NOTE).toContain("contador");
    expect(PUSH_OPTIONAL_NOTE).toContain("sino");
  });
});
