// Grava `version.json` na raiz com o commit em uso (hash, data, assunto, ramo, número de commits, mudanças locais e o origin
// SEM credencial). A imagem Docker não leva a pasta `.git`; este arquivo é como o app descobre a própria versão lá dentro.
// `npm run docker:up` roda isto antes do build. Sem git ou sem `.git`, não grava nada e não falha (a versão cai no package.json).
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
const file = path.join(root, "version.json");

function cleanOrigin(raw) {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return raw.replace(/^[^@/\s]+@(?!github\.com:)/, ""); // formato scp (git@host:dono/repo): o usuário `git` é público
  }
}

try {
  const [commit, date, ...subject] = git("log", "-1", "--format=%H%x1f%cI%x1f%s", "HEAD").split("\x1f");
  const optional = (...args) => {
    try {
      return git(...args);
    } catch {
      return "";
    }
  };
  const data = {
    commit,
    date,
    subject: subject.join("\x1f"),
    branch: optional("symbolic-ref", "--short", "-q", "HEAD"),
    count: Number.parseInt(git("rev-list", "--count", "HEAD"), 10),
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    origin: cleanOrigin(optional("config", "--get", "remote.origin.url")),
  };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`write-version: ${data.commit.slice(0, 7)} (build ${data.count}) gravado em version.json`);
} catch {
  rmSync(file, { force: true });
  console.log("write-version: sem repositório git aqui; a versão virá só do package.json.");
}
