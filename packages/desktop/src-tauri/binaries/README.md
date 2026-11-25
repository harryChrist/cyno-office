# Sidecar do Node.js

Antes de compilar com `npm run tauri build` no Windows, coloque aqui o binário do Node.js para Windows x64 com o sufixo da arquitetura exigido pelo Tauri:

```text
node-x86_64-pc-windows-msvc.exe
```

O workflow `.github/workflows/desktop.yml` baixa esse binário automaticamente. Não versione `.exe` no repositório.
