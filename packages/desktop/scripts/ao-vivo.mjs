// Modo ao vivo do app de Windows: ver mudanças da interface (packages/web) em segundos, sem gerar o instalador.
//
//   npm run ao-vivo
//
// O que faz:
//   1. fecha o Cyno Office, se estiver aberto;
//   2. liga o Vite em modo observador (`vite build --watch`): a cada arquivo salvo ele refaz SÓ a web, em ~1 a 2 s,
//      em packages/web/dist;
//   3. abre o app instalado apontando CYNO_WEB_DIR para essa pasta: o servidor interno passa a servir a web daí,
//      em vez da cópia que vai dentro do instalador.
// Depois de editar, espere o Vite avisar "built" aqui no terminal e aperte Ctrl+R (ou F5) na janela do app.
// Ctrl+C neste terminal encerra o observador e fecha o app; na próxima vez que abrir pelo ícone ele volta ao normal.
//
// Só vale para a interface. Mudanças no servidor (packages/server) ou no Rust (packages/desktop/src-tauri) ainda
// precisam de `node packages/desktop/scripts/build-resources.mjs --platform win32-x64` e do build do Tauri.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const webDir = path.join(root, "packages", "web");
const dist = path.join(webDir, "dist");

if (process.platform !== "win32") {
  console.error("[ao-vivo] Este modo é do app de Windows. No navegador, use `npm run dev` (já recarrega sozinho).");
  process.exit(1);
}

const exe = process.env.CYNO_APP_EXE || path.join(process.env.LOCALAPPDATA || "", "Cyno Office", "cyno-office.exe");
if (!existsSync(exe)) {
  console.error(`[ao-vivo] Não achei o app instalado em ${exe}. Instale o Cyno Office primeiro (ou defina CYNO_APP_EXE).`);
  process.exit(1);
}

const closeApp = () => spawnSync("taskkill", ["/IM", path.basename(exe), "/T", "/F"], { stdio: "ignore", windowsHide: true });

// O Vite não exporta `bin/vite.js` pelo `require.resolve`: acha a pasta dele pelo package.json (que é exportado).
const viteBin = path.join(path.dirname(createRequire(path.join(webDir, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
let app;
let launched = false;

console.log("[ao-vivo] Fechando o app, se estiver aberto…");
closeApp();

console.log("[ao-vivo] Ligando o observador da web (primeira montagem leva uns segundos)…");
const watcher = spawn(process.execPath, [viteBin, "build", "--watch"], { cwd: webDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

const onOutput = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!launched && /built in/i.test(text)) {
    launched = true;
    console.log(`\n[ao-vivo] Abrindo o app lendo a web de ${dist}`);
    app = spawn(exe, [], { env: { ...process.env, CYNO_WEB_DIR: dist }, stdio: "ignore", windowsHide: false });
    app.on("exit", () => console.log("[ao-vivo] O app saiu. O observador continua; feche aqui com Ctrl+C."));
    console.log("[ao-vivo] Pronto. Edite a interface, espere o Vite avisar 'built in' aqui e aperte Ctrl+R na janela do app.\n");
  }
};
watcher.stdout.on("data", onOutput);
watcher.stderr.on("data", onOutput);
watcher.on("exit", (code) => {
  console.log(`[ao-vivo] O observador terminou (código ${code}).`);
  closeApp();
  process.exit(code ?? 0);
});

const stop = () => {
  watcher.kill();
  closeApp();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
