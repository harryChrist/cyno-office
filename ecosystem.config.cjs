// PM2: mantém o maestri rodando em segundo plano e o reinicia se cair.
// Mesmo que `npm start` (sem watch: só reinicia quando alguém manda), mas com server e web como
// processos separados (logs e reinício independentes): pm2 logs maestri-server / maestri-web.
// Depois de mudar o código: pm2 restart maestri-server (server) / pm2 restart maestri-web (recompila a web).
//
// Só Linux e macOS. No Windows o pm2 não serve: `bash` vira o atalho do WSL, o PATH daqui é de
// Linux e os terminais dos agentes também. Lá o caminho é o Docker (`npm run docker:up`) ou
// rodar tudo de dentro do Ubuntu no WSL2. Recusar aqui evita o pm2 ficar reiniciando sem parar.
if (process.platform === "win32") {
  throw new Error(
    [
      "",
      "O pm2 do Cyno só funciona no Linux e no macOS.",
      "No Windows, suba pelo Docker:  npm run docker:up   (depois abra http://localhost:3067)",
      "ou rode o projeto de dentro do Ubuntu no WSL2.",
      "Se o pm2 já estava reiniciando sem parar:  npx pm2 delete maestri-server maestri-web",
      "",
    ].join("\n"),
  );
}

const PATH = `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

// Reinício com limite de verdade. O pm2 só conta uma queda como "instável" quando o processo viveu
// menos que `min_uptime` (padrão: 1 s), e só as instáveis contam para `max_restarts`. Um processo
// que leva 2 s para falhar reiniciava para sempre. Com estes valores, quem cai logo depois de subir
// é tentado 10 vezes e fica parado como "errored"; quem cai depois de rodar bem volta normalmente.
const RESTART = { autorestart: true, restart_delay: 3000, max_restarts: 10 };

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
      ...RESTART,
      min_uptime: 30_000,
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
      ...RESTART,
      // a compilação entra na conta: só vale como "subiu" depois de compilar e ficar servindo
      min_uptime: 120_000,
    },
  ],
};
