// PM2: mantém o maestri rodando em segundo plano e o reinicia se cair.
// Mesmo que `npm start` (sem watch: só reinicia quando alguém manda), mas com server e web como
// processos separados (logs e reinício independentes): pm2 logs maestri-server / maestri-web.
// Depois de mudar o código: pm2 restart maestri-server (server) / pm2 restart maestri-web (recompila a web).
const PATH = `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

// `.env` opcional na raiz (fora do git): as variáveis dele vão para o server e para a web.
// Exemplo: BROWSER_BLOCKED_HOSTS e WEB_ALLOWED_HOSTS. Sem o arquivo, nada muda.
/* eslint-disable @typescript-eslint/no-require-imports -- arquivo CommonJS do pm2 */
let fromFile = {};
try {
  fromFile = require("node:util").parseEnv(require("node:fs").readFileSync(`${__dirname}/.env`, "utf8"));
} catch {
  // sem .env (ou ilegível): segue com o padrão
}

module.exports = {
  apps: [
    {
      name: "maestri-server",
      cwd: __dirname,
      script: "npm",
      args: "run start -w @cyno/server",
      // as CLIs dos agentes (claude, agy) ficam em ~/.local/bin
      env: { ...fromFile, PATH },
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      // tempo para o shutdown limpo (fechar terminais, navegador e o diário) antes do SIGKILL
      kill_timeout: 10000,
    },
    {
      name: "maestri-web",
      cwd: __dirname,
      // compila a web e serve a versão compilada (vite preview, com o mesmo proxy e porta do dev)
      script: "bash",
      args: ["-c", "npm run build -w @cyno/web && exec npm run preview -w @cyno/web"],
      env: { ...fromFile, PATH },
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
    },
  ],
};
