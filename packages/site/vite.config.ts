import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Endereço público do site, só para as tags de compartilhamento (og:image precisa de URL absoluta).
// Na Vercel vem sozinho (VERCEL_PROJECT_PRODUCTION_URL); em outro lugar, defina SITE_URL. Sem nenhum dos dois, fica relativo.
function siteUrl(): string {
  const explicit = process.env.SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : "";
}

const siteUrlPlugin: Plugin = {
  name: "cyno-site-url",
  transformIndexHtml: (html) => html.replaceAll("__SITE_URL__", siteUrl()),
};

// As imagens do motor de cena e o texto da licença dele ficam em packages/web/public (uma cópia só, a do app).
// O site as serve nos mesmos endereços (/cena/assets/... e /licencas/cena-LICENSE.txt) em dev, preview e build.
const webPublic = resolve(fileURLToPath(new URL(".", import.meta.url)), "../web/public");
const compartilhados = ["cena", "licencas"];
const tipos: Record<string, string> = { ".png": "image/png", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp", ".svg": "image/svg+xml" };

function arquivosDe(pasta: string, prefixo = ""): string[] {
  return readdirSync(pasta).flatMap((nome) => {
    const caminho = join(pasta, nome);
    return statSync(caminho).isDirectory() ? arquivosDe(caminho, `${prefixo}${nome}/`) : [`${prefixo}${nome}`];
  });
}

const cenaDoApp: Plugin = {
  name: "cyno-cena-do-app",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? "").split("?")[0] ?? "";
      const topo = url.split("/")[1] ?? "";
      if (!compartilhados.includes(topo) || url.includes("..")) return next();
      const arquivo = join(webPublic, decodeURIComponent(url));
      if (!existsSync(arquivo) || !statSync(arquivo).isFile()) return next();
      res.setHeader("Content-Type", tipos[extname(arquivo)] ?? "application/octet-stream");
      createReadStream(arquivo).pipe(res);
    });
  },
  generateBundle() {
    for (const topo of compartilhados) {
      const base = join(webPublic, topo);
      if (!existsSync(base)) this.error(`Não achei ${base}: o site precisa do repositório inteiro (packages/web/public) para servir a arte do motor de cena.`);
      for (const rel of arquivosDe(base)) this.emitFile({ type: "asset", fileName: `${topo}/${rel}`, source: readFileSync(join(base, rel)) });
    }
  },
};

export default defineConfig({
  plugins: [react(), siteUrlPlugin, cenaDoApp],
  server: { host: "127.0.0.1", port: 5480 },
  preview: { host: "127.0.0.1", port: 5482, strictPort: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // O motor de cena fica num chunk próprio, baixado só quando o mapa entra na tela.
        codeSplitting: { groups: [{ name: "cena", test: /packages[\\/]cena[\\/]/, priority: 3 }] },
      },
    },
  },
});
