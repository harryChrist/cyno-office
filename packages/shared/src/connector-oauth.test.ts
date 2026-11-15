import { describe, expect, it } from "vitest";
import { defaultOAuthScopes, GMAIL_API_SCOPES, GMAIL_READONLY_SCOPE, oauthDiscoverBodySchema, effectiveRedirectMode, isFullAccessScope, isGoogleIssuer, isLocalOrigin, needsPasteBack, OAUTH_LOCAL_REDIRECT_URI, oauthRedirectFor, oauthRedirectUri, parsePastedCallbackUrl, redirectOriginIssue, risksOf, sameIssuer, scopeRisk } from "./connector-oauth";

const GMAIL = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.drafts",
  "https://www.googleapis.com/auth/gmail.drafts.create",
  "https://www.googleapis.com/auth/gmail.drafts.readonly",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.labels.readonly",
  "https://www.googleapis.com/auth/gmail.messages",
  "https://www.googleapis.com/auth/gmail.messages.delete",
  "https://www.googleapis.com/auth/gmail.messages.modify",
  "https://www.googleapis.com/auth/gmail.messages.readonly",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

describe("escopos padrão", () => {
  it("lista curta: todos, menos acesso total", () => {
    expect(defaultOAuthScopes(["default", "ema_issuer:manage"])).toEqual(["default", "ema_issuer:manage"]);
    expect(defaultOAuthScopes(["read", "write", "https://mail.google.com/"])).toEqual(["read", "write"]);
  });

  it("lista longa (Gmail): leitura e rascunhos; nunca o acesso total", () => {
    const picked = defaultOAuthScopes(GMAIL);
    expect(picked).toEqual(["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]);
    expect(picked).not.toContain("https://mail.google.com/");
  });

  it("lista longa sem escopo de leitura: pega um que não seja de acesso total", () => {
    const many = ["a:full", "b:one", "c:two", "d:three", "e:four", "f:five", "g:six", "h:seven"];
    expect(defaultOAuthScopes(many)).toEqual(["b:one"]);
  });
});

describe("risco de escopo", () => {
  it("classifica leitura, escrita, envio, exclusão e acesso total", () => {
    expect(scopeRisk("https://www.googleapis.com/auth/gmail.readonly")).toBe("none");
    expect(scopeRisk("https://www.googleapis.com/auth/gmail.metadata")).toBe("none");
    expect(scopeRisk("https://www.googleapis.com/auth/gmail.compose")).toBe("write");
    expect(scopeRisk("https://www.googleapis.com/auth/gmail.modify")).toBe("write");
    expect(scopeRisk("https://www.googleapis.com/auth/gmail.send")).toBe("send");
    expect(scopeRisk("https://www.googleapis.com/auth/gmail.messages.delete")).toBe("delete");
    expect(scopeRisk("https://mail.google.com/")).toBe("full");
    expect(isFullAccessScope("https://mail.google.com/")).toBe(true);
    expect(scopeRisk("default")).toBe("none");
  });

  it("junta os riscos dos marcados", () => {
    expect(risksOf(["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.compose"])).toEqual({ full: [], write: ["https://www.googleapis.com/auth/gmail.compose"], send: ["https://www.googleapis.com/auth/gmail.send"], delete: [] });
  });
});

describe("endereço de retorno", () => {
  it("monta origem + caminho fixo", () => {
    expect(oauthRedirectUri("https://app.exemplo")).toBe("https://app.exemplo/api/library/oauth/callback");
    expect(oauthRedirectUri("http://localhost:5173/")).toBe("http://localhost:5173/api/library/oauth/callback");
    expect(() => oauthRedirectUri("nao-e-url")).toThrow();
  });

  it("https e localhost servem; IP de rede em http não", () => {
    expect(redirectOriginIssue("https://app.exemplo")).toBeUndefined();
    expect(redirectOriginIssue("http://localhost:5173")).toBeUndefined();
    expect(redirectOriginIssue("http://127.0.0.1:5173")).toBeUndefined();
    expect(redirectOriginIssue("http://192.168.0.10:5173")).toMatch(/https/);
    expect(redirectOriginIssue("http://app.exemplo")).toMatch(/https/);
  });

  it("reconhece o Google e compara emissores sem a barra final", () => {
    expect(isGoogleIssuer("https://accounts.google.com/")).toBe(true);
    expect(isGoogleIssuer("https://accounts.google.com.evil.example")).toBe(false);
    expect(sameIssuer("https://accounts.google.com/", "https://accounts.google.com")).toBe(true);
    expect(sameIssuer("https://a.example", "https://b.example")).toBe(false);
  });
});

describe("modo do endereço de retorno", () => {
  it("o modo efetivo é o guardado; sem ele, local para cliente digitado e app para cadastro dinâmico", () => {
    expect(effectiveRedirectMode(undefined, "manual")).toBe("local");
    expect(effectiveRedirectMode(undefined, "dynamic")).toBe("app");
    expect(effectiveRedirectMode("app", "manual")).toBe("app");
    expect(effectiveRedirectMode("local", "dynamic")).toBe("local");
  });

  it("reconhece origens da própria máquina", () => {
    expect(isLocalOrigin("http://localhost:5173")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalOrigin("http://[::1]:5173")).toBe(true);
    expect(isLocalOrigin("https://app.exemplo")).toBe(false);
    expect(isLocalOrigin("http://192.168.0.10:5173")).toBe(false);
  });

  it("local: usa a própria origem se já é localhost; senão o endereço fixo. app: sempre a origem", () => {
    expect(OAUTH_LOCAL_REDIRECT_URI).toBe("http://localhost:5173/api/library/oauth/callback");
    expect(oauthRedirectFor("local", "http://localhost:5411")).toBe("http://localhost:5411/api/library/oauth/callback");
    expect(oauthRedirectFor("local", "https://app.exemplo")).toBe(OAUTH_LOCAL_REDIRECT_URI);
    expect(oauthRedirectFor("local", "http://192.168.0.10:5173")).toBe(OAUTH_LOCAL_REDIRECT_URI);
    expect(oauthRedirectFor("app", "https://app.exemplo")).toBe("https://app.exemplo/api/library/oauth/callback");
    expect(oauthRedirectFor("app", "http://localhost:5411")).toBe("http://localhost:5411/api/library/oauth/callback");
  });

  it("só precisa colar de volta no modo local com o app aberto fora de localhost", () => {
    expect(needsPasteBack("local", "https://app.exemplo")).toBe(true);
    expect(needsPasteBack("local", "http://localhost:5173")).toBe(false);
    expect(needsPasteBack("app", "https://app.exemplo")).toBe(false);
  });

  it("interpreta o endereço colado e recusa outro caminho ou texto qualquer", () => {
    expect(parsePastedCallbackUrl("  http://localhost:5173/api/library/oauth/callback?code=c&state=s&iss=https%3A%2F%2Fx.exemplo \n")).toEqual({ state: "s", code: "c", error: undefined, errorDescription: undefined, iss: "https://x.exemplo" });
    expect(parsePastedCallbackUrl("http://localhost:5173/api/library/oauth/callback?error=access_denied&state=s")).toMatchObject({ error: "access_denied", state: "s" });
    expect(parsePastedCallbackUrl("http://localhost:5173/outro?code=c&state=s")).toBeUndefined();
    expect(parsePastedCallbackUrl("ftp://localhost/api/library/oauth/callback?code=c")).toBeUndefined();
    expect(parsePastedCallbackUrl("isto não é um endereço")).toBeUndefined();
  });
});

describe("Gmail pela API", () => {
  it("só ler vem marcado; criar rascunhos o dono marca de propósito", () => {
    expect(defaultOAuthScopes([...GMAIL_API_SCOPES])).toEqual([GMAIL_READONLY_SCOPE]);
    expect(defaultOAuthScopes([...GMAIL_API_SCOPES].reverse())).toEqual([GMAIL_READONLY_SCOPE]);
  });

  it("a descoberta aceita exatamente uma origem: url, conector ou o modo embutido", () => {
    expect(oauthDiscoverBodySchema.safeParse({ builtin: "gmail-api" }).success).toBe(true);
    expect(oauthDiscoverBodySchema.safeParse({ url: "https://x.example/mcp" }).success).toBe(true);
    expect(oauthDiscoverBodySchema.safeParse({ builtin: "gmail-api", url: "https://x.example/mcp" }).success).toBe(false);
    expect(oauthDiscoverBodySchema.safeParse({}).success).toBe(false);
    expect(oauthDiscoverBodySchema.safeParse({ builtin: "outro" }).success).toBe(false);
  });
});
