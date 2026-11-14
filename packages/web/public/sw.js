// Service worker do Cyno. Faz três coisas e só: mostra a notificação de atenção (no Android o navegador exige
// `registration.showNotification`), mostra o aviso que chega por Web Push com o site FECHADO, e leva o clique
// numa notificação ao alerta (focando uma aba do Cyno ou abrindo uma nova no destino).
// Não guarda nada em cache e não intercepta nenhuma requisição.
const ICON = "/icon-192.png";
const ATTENTION_EVENT = "cyno:attention-open";
const SUBSCRIBE_PATH = "/api/attention/push/subscribe";
const KEY_PATH = "/api/attention/push/key";
const UNSUBSCRIBE_PATH = "/api/attention/push/unsubscribe";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** O destino do clique: o `url` que o servidor mandou, ou `/?alert=<chave>`, ou a raiz. Só caminhos do próprio Cyno. */
function targetUrl(data) {
  const url = data && typeof data.url === "string" ? data.url : "";
  // Contrabarra: o navegador trata "/\\evil.com" como "//evil.com" (outro site). Recusada.
  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) return url;
  const key = data && typeof data.key === "string" ? data.key : "";
  return key ? "/?alert=" + encodeURIComponent(key) : "/";
}

function parsePayload(event) {
  try {
    return event.data ? event.data.json() || {} : {};
  } catch {
    try {
      return { body: event.data ? event.data.text() : "" };
    } catch {
      return {};
    }
  }
}

/** O que o push traz (JSON); texto solto ou corpo vazio ainda mostram algo, porque o navegador exige uma notificação por push. */
function readPush(event) {
  const payload = parsePayload(event);
  const text = (value, fallback) => (typeof value === "string" && value.trim() ? value : fallback);
  const key = text(payload.key, "");
  return {
    title: text(payload.title, "Cyno · precisa de você"),
    options: {
      body: text(payload.body, "Algo está esperando você."),
      tag: text(payload.tag, key || "cyno"),
      icon: ICON,
      badge: ICON,
      data: { key, url: targetUrl({ url: payload.url, key }) },
    },
  };
}

self.addEventListener("push", (event) => {
  const { title, options } = readPush(event);
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Prefere a aba visível ou focada; senão, qualquer uma do Cyno. */
function pickWindow(windows) {
  return windows.find((w) => w.focused) || windows.find((w) => w.visibilityState === "visible") || windows[0];
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const key = typeof data.key === "string" ? data.key : undefined;
  const url = targetUrl(data);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = pickWindow(windows);
      if (open) {
        try {
          await open.focus();
          open.postMessage({ type: ATTENTION_EVENT, key });
          return;
        } catch {
          // A aba sumiu entre a lista e o foco: abre uma nova.
        }
      }
      // Sem aba aberta (site fechado): abre uma nova já no alerta (a página lê `?alert=`).
      await self.clients.openWindow(url);
    }),
  );
});

/** O navegador trocou a inscrição (expirou, ou o dono limpou os dados): inscreve de novo e avisa o servidor. */
async function resubscribe(event) {
  const old = event.oldSubscription;
  let options = event.newSubscription ? null : old && old.options;
  let subscription = event.newSubscription || null;
  if (!subscription) {
    if (!options || !options.applicationServerKey) {
      const response = await fetch(KEY_PATH, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const { publicKey } = await response.json();
      options = { userVisibleOnly: true, applicationServerKey: publicKey };
    }
    subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey });
  }
  const json = subscription.toJSON();
  // O endereço velho já não vale: tira da lista para o dono não ver o mesmo aparelho duas vezes.
  if (old && old.endpoint && old.endpoint !== json.endpoint) {
    await fetch(UNSUBSCRIBE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: old.endpoint }) }).catch(() => undefined);
  }
  await fetch(SUBSCRIBE_PATH, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys }, name: "Aparelho reinscrito" }),
  });
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event).catch(() => undefined));
});
