#!/usr/bin/env node
/**
 * Empacota o servidor autônomo + interface estática do Cyno Office para a casca Tauri:
 *   - packages/desktop/src-tauri/resources/server/entry.mjs        (bundle ESM via esbuild)
 *   - packages/desktop/src-tauri/resources/server/package.json     ({"type":"module"})
 *   - packages/desktop/src-tauri/resources/server/node_modules/@lydell/node-pty (+ binário da plataforma)
 *   - packages/desktop/src-tauri/resources/web/                    (cópia de packages/web/dist)
 *
 * Uso:
 *   node packages/desktop/scripts/build-resources.mjs --platform win32-x64
 *   node packages/desktop/scripts/build-resources.mjs --platform host
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");
const RESOURCES_DIR = path.join(DESKTOP_DIR, "src-tauri", "resources");
const SERVER_OUT_DIR = path.join(RESOURCES_DIR, "server");
const WEB_OUT_DIR = path.join(RESOURCES_DIR, "web");
const WEB_DIST_DIR = path.join(REPO_ROOT, "packages", "web", "dist");
const SERVER_ENTRY_SRC = path.join(REPO_ROOT, "packages", "server", "src", "desktop-entry.ts");
const SERVER_TSCONFIG = path.join(REPO_ROOT, "packages", "server", "tsconfig.json");
const SERVER_PKG_JSON = path.join(REPO_ROOT, "packages", "server", "package.json");
const ROOT_NODE_MODULES = path.join(REPO_ROOT, "node_modules");

function parsePlatformArg(argv) {
  let value;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--platform") {
      value = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--platform=")) {
      value = arg.slice("--platform=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log("Uso: node packages/desktop/scripts/build-resources.mjs --platform win32-x64|host");
      process.exit(0);
    } else {
      throw new Error(`Argumento desconhecido: ${arg}. Use --platform win32-x64|host.`);
    }
  }
  const resolved = value ?? (process.platform === "win32" ? "win32-x64" : "host");
  if (resolved !== "win32-x64" && resolved !== "host") {
    throw new Error(`Valor inválido para --platform: "${resolved}". Use "win32-x64" ou "host".`);
  }
  return resolved;
}

function loadEsbuild() {
  const rootRequire = createRequire(path.join(REPO_ROOT, "package.json"));
  try {
    return rootRequire("esbuild");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `esbuild não encontrado em node_modules da raiz (${REPO_ROOT}). ` +
        `Execute "npm ci" na raiz do repositório antes de rodar build-resources.mjs. Detalhe: ${reason}`,
      { cause: error },
    );
  }
}

function cleanDirKeeping(dir, keepNames) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (keepNames.has(entry)) continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function readNodePtyVersion() {
  const installedPkg = path.join(ROOT_NODE_MODULES, "@lydell", "node-pty", "package.json");
  if (existsSync(installedPkg)) {
    const data = JSON.parse(readFileSync(installedPkg, "utf8"));
    if (typeof data.version === "string" && data.version.trim()) return data.version.trim();
  }
  const serverPkg = JSON.parse(readFileSync(SERVER_PKG_JSON, "utf8"));
  const declared = serverPkg.dependencies?.["@lydell/node-pty"];
  if (typeof declared === "string" && declared.trim()) {
    return declared.replace(/^[\^~]/, "").trim();
  }
  throw new Error("Não foi possível determinar a versão de @lydell/node-pty.");
}

function runCommandOrFail(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32" && (command === "npm" || command === "npm.cmd"),
  });
  if (result.error) {
    throw new Error(`${label} falhou ao iniciar "${command}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${label} falhou (código ${result.status})${detail ? `:\n${detail}` : "."}`);
  }
  return (result.stdout || "").trim();
}

function copyWebDist() {
  const indexHtml = path.join(WEB_DIST_DIR, "index.html");
  if (!existsSync(indexHtml)) {
    throw new Error(
      `Build da interface web não encontrado em ${WEB_DIST_DIR}. ` +
        `Execute "npm run build -w @cyno/web" na raiz do repositório antes.`,
    );
  }
  cleanDirKeeping(WEB_OUT_DIR, new Set([".gitkeep"]));
  cpSync(WEB_DIST_DIR, WEB_OUT_DIR, { recursive: true, force: true });
}

function prepareNodePty(targetPlatform) {
  const ptySrc = path.join(ROOT_NODE_MODULES, "@lydell", "node-pty");
  if (!existsSync(ptySrc)) {
    throw new Error(
      `Pacote @lydell/node-pty não encontrado em ${ptySrc}. Execute "npm ci" na raiz do repositório antes.`,
    );
  }

  const version = readNodePtyVersion();
  const outNodeModules = path.join(SERVER_OUT_DIR, "node_modules");
  const outScope = path.join(outNodeModules, "@lydell");
  rmSync(outNodeModules, { recursive: true, force: true });
  mkdirSync(outScope, { recursive: true });

  cpSync(ptySrc, path.join(outScope, "node-pty"), { recursive: true, dereference: true });

  if (targetPlatform === "host") {
    const hostPkgName = `node-pty-${process.platform}-${process.arch}`;
    const hostPkgSrc = path.join(ROOT_NODE_MODULES, "@lydell", hostPkgName);
    if (!existsSync(hostPkgSrc)) {
      throw new Error(
        `Binário nativo @lydell/${hostPkgName} não encontrado em ${hostPkgSrc}. ` +
          `Execute "npm ci" na raiz do repositório para instalar o pacote desta plataforma.`,
      );
    }
    cpSync(hostPkgSrc, path.join(outScope, hostPkgName), { recursive: true, dereference: true });
    return { version, nativePackage: `@lydell/${hostPkgName}`, source: "local" };
  }

  // targetPlatform === "win32-x64"
  const winPkgName = "node-pty-win32-x64";
  const localWinSrc = path.join(ROOT_NODE_MODULES, "@lydell", winPkgName);
  const localWinPkgJson = path.join(localWinSrc, "package.json");
  if (existsSync(localWinPkgJson)) {
    const localVersion = JSON.parse(readFileSync(localWinPkgJson, "utf8")).version;
    if (localVersion === version) {
      cpSync(localWinSrc, path.join(outScope, winPkgName), { recursive: true, dereference: true });
      return { version, nativePackage: `@lydell/${winPkgName}`, source: "local" };
    }
  }

  const spec = `@lydell/${winPkgName}@${version}`;
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cyno-node-pty-"));
  try {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      runCommandOrFail(npmBin, ["pack", spec, "--pack-destination", tmpDir, "--silent"], `npm pack ${spec}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Não foi possível baixar ${spec} do registro npm (sem acesso à rede ou erro no registro). ` +
          `Para testar localmente no host sem baixar o pacote Windows, use "--platform host".\n${detail}`,
        { cause: error },
      );
    }

    const tgzName = readdirSync(tmpDir).find((name) => name.endsWith(".tgz"));
    if (!tgzName) {
      throw new Error(`npm pack ${spec} concluiu sem gerar arquivo .tgz em ${tmpDir}.`);
    }

    const extractDir = path.join(tmpDir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    runCommandOrFail("tar", ["-xzf", path.join(tmpDir, tgzName), "-C", extractDir], `Extrair ${tgzName}`);

    const pkgDir = path.join(extractDir, "package");
    if (!existsSync(pkgDir)) {
      throw new Error(`Tarball ${tgzName} não contém o diretório esperado "package/".`);
    }
    cpSync(pkgDir, path.join(outScope, winPkgName), { recursive: true, dereference: true });
    return { version, nativePackage: `@lydell/${winPkgName}`, source: "npm-pack" };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function bundleServer(esbuild) {
  mkdirSync(SERVER_OUT_DIR, { recursive: true });
  const outfile = path.join(SERVER_OUT_DIR, "entry.mjs");

  await esbuild.build({
    entryPoints: [SERVER_ENTRY_SRC],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    tsconfig: SERVER_TSCONFIG,
    external: ["@lydell/node-pty", "@lydell/node-pty-*", "playwright-core"],
    banner: {
      js: 'import { createRequire as __cynoCreateRequire } from "node:module";\nconst require = __cynoCreateRequire(import.meta.url);\n',
    },
    logLevel: "warning",
  });

  writeFileSync(path.join(SERVER_OUT_DIR, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");
  return outfile;
}

async function main() {
  const targetPlatform = parsePlatformArg(process.argv.slice(2));
  const esbuild = loadEsbuild();

  const entryFile = await bundleServer(esbuild);
  copyWebDist();
  const ptyInfo = prepareNodePty(targetPlatform);

  console.log(
    [
      `[build-resources] Recursos prontos (platform=${targetPlatform})`,
      `  server: ${path.relative(REPO_ROOT, entryFile)}`,
      `  web:    ${path.relative(REPO_ROOT, WEB_OUT_DIR)}`,
      `  pty:    @lydell/node-pty@${ptyInfo.version} + ${ptyInfo.nativePackage} (${ptyInfo.source})`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(`[build-resources] Erro: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
