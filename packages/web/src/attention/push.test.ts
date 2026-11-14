import { describe, expect, it } from "vitest";
import swSource from "../../public/sw.js?raw";
import { alertKeyFromSearch, deviceName, pushStateOf, urlBase64ToBytes } from "./push";

describe("pushStateOf: o estado deste aparelho", () => {
  const base = { secure: true, supported: true, permission: "default" as const, subscribed: false };
  it("endereço inseguro vem antes de tudo (o botão nem aparece)", () => {
    expect(pushStateOf({ ...base, secure: false, supported: false })).toBe("insecure");
  });
  it("sem suporte, bloqueado, desligado e ligado", () => {
    expect(pushStateOf({ ...base, supported: false })).toBe("unsupported");
    expect(pushStateOf({ ...base, permission: "denied" })).toBe("blocked");
    expect(pushStateOf(base)).toBe("off");
    expect(pushStateOf({ ...base, permission: "granted" })).toBe("off");
    expect(pushStateOf({ ...base, permission: "granted", subscribed: true })).toBe("on");
    // Inscrito mas a permissão foi retirada depois: não está ligado de verdade.
    expect(pushStateOf({ ...base, permission: "default", subscribed: true })).toBe("off");
  });
});

describe("helpers puros", () => {
  it("nome do aparelho", () => {
    expect(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe("Chrome no Android");
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari no iPhone");
    expect(deviceName("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0")).toBe("Firefox no Linux");
    expect(deviceName("")).toBe("Navegador");
  });
  it("a chave VAPID em base64url vira bytes", () => {
    expect([...urlBase64ToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToBytes("-_8")]).toEqual([251, 255]);
  });
  it("lê a chave do alerta do endereço", () => {
    expect(alertKeyFromSearch("?alert=approval%3Aprincipal%3Ait-1")).toBe("approval:principal:it-1");
    expect(alertKeyFromSearch("?x=1")).toBeUndefined();
    expect(alertKeyFromSearch(`?alert=${"a".repeat(300)}`)).toBeUndefined();
  });
});

// O service worker de verdade (public/sw.js) rodado numa caixa com um `self` falso: o que dá para testar como função.
type Handler = (event: Record<string, unknown>) => void;
function loadWorker(options: { windows?: Record<string, unknown>[]; fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<unknown>; subscribeImpl?: () => Promise<unknown> } = {}) {
  const handlers = new Map<string, Handler>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const fetched: { url: string; init?: Record<string, unknown> }[] = [];
  const self = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: () => Promise.resolve(),
    registration: {
      showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, options: opts }),
      pushManager: { subscribe: options.subscribeImpl ?? (async () => ({ toJSON: () => ({ endpoint: "https://push.example.test/new", keys: { p256dh: "p", auth: "a" } }) })) },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => options.windows ?? [],
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  const fetchFn = async (url: string, init?: Record<string, unknown>) => {
    fetched.push({ url, ...(init ? { init } : {}) });
    return options.fetchImpl ? options.fetchImpl(url, init) : { ok: true, json: async () => ({ publicKey: "AQID" }) };
  };
  new Function("self", "fetch", swSource)(self, fetchFn);
  const run = async (type: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => (work = promise) });
    await work;
  };
  return { run, shown, opened, fetched };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => payload, text: () => String(payload) } });

describe("sw.js: push", () => {
  it("mostra a notificação com título, corpo, tag, ícone e o destino", async () => {
    const sw = loadWorker();
    await sw.run("push", pushEvent({ title: "Cyno · precisa de você", body: "Eco pediu o seu OK · Principal", tag: "approval:p:1", key: "approval:p:1", url: "/?alert=approval%3Ap%3A1" }));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe("Cyno · precisa de você");
    expect(sw.shown[0]!.options).toMatchObject({ body: "Eco pediu o seu OK · Principal", tag: "approval:p:1", icon: "/icon-192.png", data: { key: "approval:p:1", url: "/?alert=approval%3Ap%3A1" } });
  });

  it("corpo ilegível ou vazio ainda mostra algo (o navegador exige uma notificação por push)", async () => {
    const sw = loadWorker();
    await sw.run("push", { data: { json: () => { throw new Error("x"); }, text: () => "texto solto" } });
    await sw.run("push", {});
    expect(sw.shown.map((s) => s.options.body)).toEqual(["texto solto", "Algo está esperando você."]);
  });

  it("não aceita destino fora do Cyno vindo no corpo do push", async () => {
    const sw = loadWorker({ windows: [] });
    await sw.run("push", pushEvent({ title: "t", body: "b", key: "k", url: "https://malvado.example/x" }));
    expect(sw.shown[0]!.options).toMatchObject({ data: { url: "/?alert=k" } });
  });
});

describe("sw.js: clique na notificação (o L9)", () => {
  const click = (data: unknown) => ({ notification: { close: () => undefined, data } });

  it("com uma aba do Cyno aberta: foca e manda a chave do alerta", async () => {
    const messages: unknown[] = [];
    let focused = 0;
    const tab = { focused: false, visibilityState: "hidden", focus: async () => void (focused += 1), postMessage: (m: unknown) => void messages.push(m) };
    const sw = loadWorker({ windows: [tab] });
    await sw.run("notificationclick", click({ key: "approval:p:1", url: "/?alert=approval%3Ap%3A1" }));
    expect(focused).toBe(1);
    expect(messages).toEqual([{ type: "cyno:attention-open", key: "approval:p:1" }]);
    expect(sw.opened).toEqual([]);
  });

  it("prefere a aba visível entre várias", async () => {
    const calls: string[] = [];
    const tab = (name: string, visibilityState: string) => ({ focused: false, visibilityState, focus: async () => void calls.push(name), postMessage: () => undefined });
    const sw = loadWorker({ windows: [tab("a", "hidden"), tab("b", "visible")] });
    await sw.run("notificationclick", click({ key: "k" }));
    expect(calls).toEqual(["b"]);
  });

  it("sem nenhuma aba (site fechado): abre uma nova já no alerta", async () => {
    const sw = loadWorker({ windows: [] });
    await sw.run("notificationclick", click({ key: "approval:p:1", url: "/?alert=approval%3Ap%3A1" }));
    expect(sw.opened).toEqual(["/?alert=approval%3Ap%3A1"]);
  });

  it("notificação feita pela página (só com a chave) também leva ao alerta; sem nada, abre a raiz", async () => {
    const sw = loadWorker({ windows: [] });
    await sw.run("notificationclick", click({ key: "a b" }));
    await sw.run("notificationclick", click(undefined));
    expect(sw.opened).toEqual(["/?alert=a%20b", "/"]);
  });

  it("recusa o endereço com contrabarra (o navegador o leria como outro site) e cai na chave ou na raiz (L6)", async () => {
    const sw = loadWorker({ windows: [] });
    await sw.run("notificationclick", click({ key: "k", url: "/\\evil.com" }));
    await sw.run("notificationclick", click({ url: "/\\evil.com/x" }));
    await sw.run("notificationclick", click({ key: "k", url: "//evil.com" }));
    expect(sw.opened).toEqual(["/?alert=k", "/", "/?alert=k"]);
  });

  it("se a aba sumiu entre a lista e o foco, abre uma nova", async () => {
    const tab = { focused: true, visibilityState: "visible", focus: async () => { throw new Error("gone"); }, postMessage: () => undefined };
    const sw = loadWorker({ windows: [tab] });
    await sw.run("notificationclick", click({ key: "k", url: "/?alert=k" }));
    expect(sw.opened).toEqual(["/?alert=k"]);
  });
});

describe("sw.js: pushsubscriptionchange", () => {
  it("reinscreve com a chave pública, avisa o servidor e tira o endereço velho", async () => {
    const sw = loadWorker();
    await sw.run("pushsubscriptionchange", { oldSubscription: { endpoint: "https://push.example.test/old", options: {} } });
    expect(sw.fetched.map((f) => f.url)).toEqual(["/api/attention/push/key", "/api/attention/push/unsubscribe", "/api/attention/push/subscribe"]);
    const body = JSON.parse(String(sw.fetched[2]!.init!.body)) as { subscription: { endpoint: string } };
    expect(body.subscription.endpoint).toBe("https://push.example.test/new");
  });

  it("com a nova inscrição já pronta, só avisa o servidor; falha de rede não derruba nada", async () => {
    const sw = loadWorker();
    await sw.run("pushsubscriptionchange", { newSubscription: { toJSON: () => ({ endpoint: "https://push.example.test/n2", keys: { p256dh: "p", auth: "a" } }) } });
    expect(sw.fetched.map((f) => f.url)).toEqual(["/api/attention/push/subscribe"]);
    const broken = loadWorker({ fetchImpl: async () => { throw new Error("offline"); } });
    await expect(broken.run("pushsubscriptionchange", { oldSubscription: { options: {} } })).resolves.toBeUndefined();
  });
});
