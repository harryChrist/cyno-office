import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, type Connect, type Plugin } from "vite";

// `.env` da raiz do repo, se existir: o que já está no ambiente vale sobre o arquivo.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // sem .env: valem os padrões
}

// O server (Fastify) escuta só em 127.0.0.1; o Vite expõe a UI na rede e faz proxy.
const serverPort = Number(process.env.PORT || 3068);
const webPort = Number(process.env.WEB_PORT || 3067);
const webHost = process.env.WEB_HOST || "0.0.0.0";
/**
 * HTTP por padrão (escolha do usuário). `WEB_HTTPS=1` liga HTTPS com certificado autoassinado:
 * o microfone (ditado por voz) só funciona em contexto seguro, e http://<ip-da-rede> não é
 * (alternativa sem HTTPS: liberar o endereço em chrome://flags/#unsafely-treat-insecure-origin-as-secure).
 */
const webHttps = process.env.WEB_HTTPS === "1";

/** IPv4 das interfaces de rede: entram no certificado junto com localhost. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((net) => (net && net.family === "IPv4" ? [net.address] : []));
}

/** `WEB_ALLOWED_HOSTS`: domínios extras aceitos no cabeçalho Host (vírgulas). */
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
const hostsOption = allowedHosts.length > 0 ? { allowedHosts } : {};

const proxy = {
  // ws: o terminal do Maestro (/api/w/<ws>/maestro/terminal) é um WebSocket dentro de /api.
  "/api": { target: `http://127.0.0.1:${serverPort}`, ws: true, xfwd: true },
  "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true, xfwd: true },
};

// Fechar uma aba enquanto o server envia eventos derruba o socket no meio da escrita.
// O proxy do Vite loga isso como erro (ECONNRESET/EPIPE), mas é só o cliente indo embora.
// ECONNREFUSED é o server fora do ar (reiniciando): o cliente só abre o WS depois de ver o
// backend de pé (/__backend-health), mas ainda pode haver uma corrida no instante em que ele cai.
// Silenciamos apenas esses códigos nos erros de proxy WS; todo o resto continua sendo logado.
const BENIGN_WS_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNREFUSED"]);
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, options) => {
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  if (msg.includes("ws proxy") && code && BENIGN_WS_CODES.has(code)) return;
  logError(msg, options);
};

/** O backend responde no /api/health? (direto, sem passar pelo proxy: nada vai para o log). */
function backendUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: serverPort, path: "/api/health", method: "GET", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * `GET /__backend-health` (fora do proxy): responde sempre 200 com `{ up: boolean }`. O cliente
 * consulta antes de abrir o WebSocket, então com o server fora (reinício) não há tentativa de WS
 * falhando nem erro no console do navegador ou no log do Vite.
 */
function backendHealth(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__backend-health") return next();
    void backendUp().then((up) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ up }));
    });
  };
  return {
    name: "cyno:backend-health",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  customLogger: logger,
  plugins: [react(), backendHealth(), ...(webHttps ? [basicSsl({ name: "cyno", domains: ["localhost", ...lanAddresses()], ttlDays: 365 })] : [])],
  // Domínios extras que chegam aqui (túnel, proxy reverso): o Vite recusa um Host que não conhece.
  // Sem WEB_ALLOWED_HOSTS fica o comportamento padrão do Vite.
  server: { host: webHost, port: webPort, strictPort: true, proxy, ...hostsOption },
  preview: { host: webHost, port: webPort, strictPort: true, proxy, ...hostsOption },
  build: {
    // O chunk vendor (react, zod, xterm) passa de 600 kB minificado; o resto fica bem abaixo.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // O motor de cena, a cidade e as libs em chunks próprios, separados do código do app (melhor cache).
        codeSplitting: {
          groups: [
            // O motor de cena (@cyno/cena) é carregado sob demanda (import dinâmico no App).
            // A cidade (faixa da página do Cyno) fica à parte do escritório: o código dela é um chunk próprio.
            // As preferências dos bichos (Configurações e a chave do Maestro) são do app inteiro: ficam num chunk pequeno,
            // sem arrastar o motor (OfficeStore) para o carregamento inicial.
            { name: "bichos-prefs", test: /web[\\/]src[\\/]cena[\\/]bichos[\\/](birdHome|prefs)\.ts/, priority: 5 },
            { name: "cidade", test: /packages[\\/]cena[\\/](client[\\/]src[\\/]world[\\/]city[\\/]|shared[\\/]world[\\/](city|social-labels))/, priority: 4 },
            { name: "cena", test: /packages[\\/]cena[\\/]/, priority: 3 },
            { name: "vendor", test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "react/jsx-dev-runtime", "zustand", "zod"],
  },
});
