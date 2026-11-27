# Cyno Office — Casca Desktop Windows (Tauri 2)

Aplicativo desktop fino em **Tauri 2** para rodar o Cyno no Windows como aplicativo instalável com ícone na bandeja, notificações nativas, diálogo de pasta do sistema e atualizador assinado.

A casca **não conhece a lógica do Cyno**: ela apenas inicia o servidor Node como processo separado (sidecar), aguarda `/api/health` e abre `http://localhost:3067` numa janela WebView2 sem barra de endereço.

> Este pacote fica **fora** de `workspaces` no `package.json` raiz para não exigir Rust nem quebrar `npm ci` / `npm run build` no CI Linux.

---

## Pré-requisitos no Windows (x64)

1. **Node.js 22.12+** (mesma versão do monorepo).
2. **Rust estável** via [rustup](https://rustup.rs/) (`x86_64-pc-windows-msvc`).
3. **Visual Studio Build Tools** com a carga de trabalho *Desenvolvimento para desktop com C++* (MSVC + Windows SDK).
4. **WebView2 Runtime** (já vem no Windows 11; o instalador inclui o bootstrapper para instalar caso falte).

---

## Como compilar no Windows

1. Na raiz do monorepo, instale as dependências e compile a interface web e os pacotes:

   ```powershell
   npm ci
   npm run build
   ```

2. Gere o pacote autônomo do servidor + web (`resources/server/entry.mjs`, `resources/server/node_modules/@lydell/node-pty*` e `resources/web/`):

   ```powershell
   node packages/desktop/scripts/build-resources.mjs --platform win32-x64
   ```

   *(Também disponível como `npm run build:resources` dentro de `packages/desktop`. No Linux, use `--platform host` ou `npm run smoke` para testar o pacote com o Node local.)*

3. Baixe o binário do Node.js Windows x64 como sidecar em `packages/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe` e confira o SHA256 oficial:

   ```powershell
   $ver = "22.15.0"
   $dest = "packages/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe"
   New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
   Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/win-x64/node.exe" -OutFile $dest
   $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/SHASUMS256.txt" -UseBasicParsing).Content
   $expected = (($sums -split "`r?`n" | Where-Object { $_ -match 'win-x64/node\.exe$' }) -split '\s+')[0].ToLowerInvariant()
   $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLowerInvariant()
   if ($actual -ne $expected) { throw "SHA256 inválido! Esperado $expected, obtido $actual" }
   ```

4. Instale a CLI do Tauri dentro de `packages/desktop` e gere os instaladores (`.exe` NSIS e `.msi`):

   ```powershell
   cd packages/desktop
   npm install
   npm run tauri build
   ```

   Os instaladores ficam em `packages/desktop/src-tauri/target/release/bundle/` (`nsis/` e `msi/`).

### Teste de fumaça (Linux ou Windows)

Depois de rodar `npm run build -w @cyno/web`, você pode validar o bundle autônomo sem precisar de Rust:

```bash
cd packages/desktop
npm run smoke
```

O script empacota com `--platform host`, sobe `resources/server/entry.mjs` numa pasta `DATA_DIR` temporária e portas livres, valida `/api/health`, `/__backend-health`, `GET /` (HTML) e uma conexão WebSocket em `/ws`, e encerra o processo de forma limpa.

### Desenvolvimento local

Com o servidor/web já rodando em `http://localhost:3067` (ou apontando `CYNO_SERVER_ENTRY` para o script de entrada do servidor):

```powershell
cd packages/desktop
$env:CYNO_SERVER_ENTRY = "C:\caminho\para\entry.mjs"
npm run dev
```

Variáveis de ambiente opcionais lidas pela casca e pelo `entry.mjs`:
- `CYNO_SERVER_ENTRY`: sobrescreve o script executado pelo sidecar Node (padrão: `resources/server/entry.mjs` dentro do pacote).
- `CYNO_WEB_DIR`: sobrescreve a pasta dos arquivos estáticos da web (padrão: `../web` relativo ao `entry.mjs`).
- `DATA_DIR`: sobrescreve a pasta de dados (padrão no Windows: `%LOCALAPPDATA%\CynoOffice\data`).
- `WEB_PORT` (padrão `3067`) e `PORT` (padrão `3068`).

---

## Chaves do atualizador assinado

O atualizador (`tauri-plugin-updater`) exige assinatura criptográfica para aceitar pacotes de `https://github.com/harryChrist/cyno-office/releases/latest/download/latest.json`.

1. Gere o par de chaves (guarde a chave privada em local seguro — **nunca** faça commit dela):

   ```powershell
   cd packages/desktop
   npx tauri signer generate -w "$HOME\.tauri\cyno-office.key"
   ```

2. Copie a **chave pública** exibida no terminal (ou no arquivo `.key.pub`) para `packages/desktop/src-tauri/tauri.conf.json`, substituindo `REPLACE_WITH_PUBLIC_KEY` em `plugins.updater.pubkey`.

3. Para o workflow `.github/workflows/desktop.yml` gerar rascunhos assinados no GitHub Actions, crie dois segredos em **Settings → Secrets and variables → Actions**:
   - `TAURI_SIGNING_PRIVATE_KEY`: conteúdo do arquivo `cyno-office.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: senha escolhida ao gerar a chave.

### Como a atualização é aplicada

- A casca checa atualizações 15 s após abrir e depois a cada 6 horas, baixando em segundo plano sem interromper o trabalho.
- Quando pronta, o item **Sair e atualizar** fica habilitado na bandeja.
- Ao escolher **Sair e atualizar** (ou no próximo início caso o usuário tenha clicado em **Sair** antes), o servidor é parado, os dados são copiados para `<DATA_DIR>/../backups/<versão>-<data>` e só então o instalador é executado.

---

## Onde cada coisa fica

| Caminho | Função |
| --- | --- |
| `packages/desktop/package.json` | Scripts `tauri`, `dev`, `build`, `build:resources`, `smoke` e `@tauri-apps/cli` ^2 |
| `packages/desktop/scripts/build-resources.mjs` | Gera `resources/server/entry.mjs` (esbuild), copia `resources/web/` e empacota `@lydell/node-pty` da plataforma |
| `packages/desktop/scripts/smoke.mjs` | Teste de fumaça ponta a ponta do bundle autônomo (`--platform host`, HTTP + WebSocket + shutdown limpo) |
| `packages/server/src/desktop-entry.ts` | Ponto de entrada autônomo do sidecar (servidor Fastify + gateway web em `127.0.0.1` + saída ao fechar stdin) |
| `packages/server/src/desktop-gateway.ts` | Gateway HTTP/WebSocket em `node:http` + `node:net` (estáticos, fallback SPA, `/__backend-health`, proxy `/api` e `/ws`) |
| `packages/desktop/frontend/index.html` | Tela mínima de carregamento enquanto o servidor sobe |
| `packages/desktop/src-tauri/Cargo.toml` | Crates do Tauri 2 e plugins (shell, single-instance, autostart, notification, dialog, updater) |
| `packages/desktop/src-tauri/tauri.conf.json` | Identificador `app.cyno.office`, janela `localhost:3067`, CSP, bundle NSIS/MSI, sidecar e atualizador |
| `packages/desktop/src-tauri/capabilities/default.json` | Permissões IPC liberadas para `http://localhost:3067/*` |
| `packages/desktop/src-tauri/src/main.rs` | Ponto de entrada binário (sem console em release no Windows) |
| `packages/desktop/src-tauri/src/lib.rs` | Inicialização de plugins, eventos da janela (`CloseRequested` → esconder) e ciclo de vida |
| `packages/desktop/src-tauri/src/server.rs` | Sidecar Node (`binaries/node`), `DATA_DIR`, checagem de `/api/health` e encerramento da árvore (`taskkill /T /F`) |
| `packages/desktop/src-tauri/src/tray.rs` | Bandeja: Abrir, Verificar atualização, Sair e atualizar, Iniciar com o Windows, Sair |
| `packages/desktop/src-tauri/src/updater.rs` | Checagem a cada 6 h, download em segundo plano, backup recursivo de dados e aplicação ao sair/iniciar |
| `packages/desktop/src-tauri/src/commands.rs` | Comandos Tauri expostos ao web (`pick_folder`, `desktop_notify`, `get_data_dir`, `is_update_ready`) |
| `packages/desktop/src-tauri/icons/` | Ícones `.png` e `.ico` gerados a partir da marca Cyno |
| `packages/web/src/desktop/desktopBridge.ts` | Ponte no web (`isDesktopApp`, `pickFolder`, `notify`) com fallback para o navegador |
| `.github/workflows/desktop.yml` | Ação manual / tag `desktop-v*` em `windows-latest` gerando Release em rascunho |
