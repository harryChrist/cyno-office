#!/usr/bin/env node
/**
 * Gera o conjunto curado de ícones de marca dos Conectores a partir do pacote simple-icons
 * (CC0 1.0, devDependency com versão exata). Escreve:
 * - packages/web/public/conectores/<slug>.svg (o SVG de 24x24 do simple-icons; a tela usa como máscara);
 * - packages/web/public/conectores/LICENSE.md (aviso CC0 + marcas registradas);
 * - packages/web/src/connectors/brands.generated.ts (slug, nome e cor da marca).
 *
 * Rodar de novo depois de mexer na lista ou atualizar o simple-icons:
 *   node packages/web/scripts/gen-connector-icons.mjs
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const icons = require("simple-icons");
// O package.json do simple-icons não está nos "exports": lê pelo caminho do pacote.
const { version } = JSON.parse(await readFile(path.join(path.dirname(require.resolve("simple-icons")), "package.json"), "utf8"));

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(WEB, "public", "conectores");
const OUT_TS = path.join(WEB, "src", "connectors", "brands.generated.ts");

/** Marcas que costumam ter servidor MCP (ou que o usuário usa); só as que existem no simple-icons. */
const CURATED = [
  // Trabalho e documentos
  "notion", "obsidian", "atlassian", "jira", "confluence", "linear", "clickup", "asana", "trello", "todoist", "miro", "airtable",
  "evernote", "calendly", "zoom", "box", "dropbox",
  // Google
  "google", "googledrive", "gmail", "googlecalendar", "googlesheets", "googledocs", "googlemaps", "googleanalytics",
  // Código e infraestrutura
  "github", "gitlab", "bitbucket", "gitea", "forgejo", "vercel", "netlify", "cloudflare", "supabase", "firebase", "digitalocean",
  "docker", "kubernetes", "proxmox", "portainer", "grafana", "prometheus", "sentry", "jenkins", "postman", "raycast",
  "postgresql", "mysql", "sqlite", "mongodb", "redis", "elasticsearch", "rabbitmq",
  // Automação e casa
  "n8n", "zapier", "make", "homarr", "homeassistant", "nextcloud", "jellyfin", "plex", "uptimekuma", "pihole", "tailscale",
  "wireguard", "bitwarden", "1password",
  // Comunicação e redes sociais
  "discord", "telegram", "whatsapp", "intercom", "mailchimp", "youtube", "instagram", "tiktok", "facebook", "threads", "x",
  "bluesky", "mastodon", "reddit", "pinterest", "medium", "substack", "twitch", "spotify",
  // Vendas e pagamentos
  "hubspot", "shopify", "wordpress", "stripe", "paypal", "mercadopago", "nubank", "ifood",
  // IA e conteúdo
  "anthropic", "claude", "huggingface", "perplexity", "similarweb", "pastebin",
  // Jogos
  "steam", "riotgames", "valorant", "leagueoflegends",
];

const bySlug = new Map();
for (const [key, icon] of Object.entries(icons)) if (key.startsWith("si") && icon && typeof icon === "object" && "slug" in icon) bySlug.set(icon.slug, icon);

const chosen = [];
const missing = [];
for (const slug of CURATED) {
  const icon = bySlug.get(slug);
  if (icon) chosen.push(icon);
  else missing.push(slug);
}

await mkdir(OUT_DIR, { recursive: true });
// Apaga os SVGs de uma geração antiga (o LICENSE é reescrito).
for (const file of await readdir(OUT_DIR)) if (file.endsWith(".svg")) await rm(path.join(OUT_DIR, file));
for (const icon of chosen) await writeFile(path.join(OUT_DIR, `${icon.slug}.svg`), `${icon.svg}\n`, "utf8");

await writeFile(
  path.join(OUT_DIR, "LICENSE.md"),
  `# Ícones dos Conectores

Os SVGs desta pasta vêm do [Simple Icons](https://simpleicons.org) ${version}, publicados sob
[CC0 1.0 Universal](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md)
(gerados por \`packages/web/scripts/gen-connector-icons.mjs\`).

Os ícones são marcas registradas dos seus donos. O uso aqui só identifica o serviço ao qual o
conector se liga e não sugere apoio nem parceria. Veja o
[aviso legal do Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md).
`,
  "utf8",
);

const lines = chosen.map((icon) => `  { slug: ${JSON.stringify(icon.slug)}, title: ${JSON.stringify(icon.title)}, hex: "#${icon.hex.toLowerCase()}" },`);
await writeFile(
  OUT_TS,
  `// Gerado por packages/web/scripts/gen-connector-icons.mjs a partir do simple-icons ${version} (CC0). Não edite à mão.

/** Marca com ícone em /conectores/<slug>.svg (cor oficial da marca em \`hex\`). */
export type ConnectorBrand = { slug: string; title: string; hex: string };

export const CONNECTOR_BRANDS: readonly ConnectorBrand[] = [
${lines.join("\n")}
];
`,
  "utf8",
);

console.log(`${chosen.length} ícones gerados em ${path.relative(process.cwd(), OUT_DIR)}${missing.length ? ` (sem no simple-icons: ${missing.join(", ")})` : ""}`);
