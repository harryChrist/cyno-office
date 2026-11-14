/**
 * `npm run auth:set-password -w @cyno/server`: define (ou troca) a senha de acesso do app.
 * `npm run auth:clear -w @cyno/server`: remove a senha (o app volta a ficar aberto).
 * `npm run auth:code` (ou `-w @cyno/server`): mostra o código de configuração do primeiro acesso.
 * `npm run auth:reset-2fa -w @cyno/server`: desliga a verificação em duas etapas (quem perdeu o celular).
 * Usa o mesmo DATA_DIR do server. O server relê auth.json sozinho: não precisa reiniciar.
 */
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, loadRootEnvFile } from "../../config";
import { SETUP_CODE_FILE } from "./routes";
import { resetTotp, writeAuthFile } from "./store";

/** Lê uma linha sem ecoar o que é digitado (precisa de um terminal). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("Rode num terminal interativo (a senha é digitada sem eco)."));
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelado."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer))));
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function setPassword(dataDir: string): Promise<void> {
  const first = await promptHidden("Nova senha (mínimo 8 caracteres): ");
  if (first.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  const second = await promptHidden("Repita a senha: ");
  if (first !== second) throw new Error("As senhas não conferem.");
  await writeAuthFile(dataDir, first);
  // Sessões antigas ficam inválidas pelo passwordId novo; o arquivo delas é só limpo.
  await rm(path.join(dataDir, "auth-sessions.json"), { force: true });
  console.log(`Senha definida em ${path.join(dataDir, "auth.json")}. Todos os aparelhos precisam entrar de novo.`);
}

async function clearPassword(dataDir: string): Promise<void> {
  const file = path.join(dataDir, "auth.json");
  if (!(await exists(file))) {
    console.log("Nenhuma senha definida.");
    return;
  }
  const answer = await promptLine("Remover a senha? O app volta ao estado de primeira instalação (o código de configuração aparece no log ao reiniciar). Digite 'sim' para confirmar: ");
  if (answer.trim().toLowerCase() !== "sim") {
    console.log("Nada foi alterado.");
    return;
  }
  await rm(file, { force: true });
  await rm(path.join(dataDir, "auth-sessions.json"), { force: true });
  console.log("Senha removida: o app volta a pedir a configuração inicial (código no log do server).");
}

/** Mostra só o código de configuração (o server o grava ao subir sem senha). */
async function showSetupCode(dataDir: string): Promise<void> {
  if (await exists(path.join(dataDir, "auth.json"))) {
    console.log("A senha já foi criada: não há código de configuração. Para trocar a senha, use as Configurações ou `npm run auth:set-password -w @cyno/server`.");
    return;
  }
  const code = await readFile(path.join(dataDir, SETUP_CODE_FILE), "utf8").then(
    (text) => text.trim(),
    () => "",
  );
  if (!code) throw new Error("Nenhum código ainda: o servidor precisa estar no ar (ele gera o código ao subir sem senha).");
  console.log(`\nCódigo de configuração: ${code}\n\nAbra o Cyno, digite esse código e crie a senha.\n`);
}

const command = process.argv[2];
loadRootEnvFile();
const { dataDir } = loadConfig();
try {
  if (command === "set-password") await setPassword(dataDir);
  else if (command === "clear") await clearPassword(dataDir);
  else if (command === "setup-code") await showSetupCode(dataDir);
  else if (command === "reset-2fa") console.log((await resetTotp(dataDir)) ? "Verificação em duas etapas desligada. O login volta a pedir só a senha." : "A verificação em duas etapas não estava ligada.");
  else throw new Error("Uso: auth-cli <set-password|clear|setup-code|reset-2fa>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
