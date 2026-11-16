import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Portas próprias por env (E2E_SERVER_PORT/E2E_WEB_PORT) para rodar com o app de dev no ar.
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3068);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3067);
const E2E_ROOT = path.join(tmpdir(), "cyno-e2e");

/**
 * DATA_DIR temporário por execução. Só o processo principal cria (e apaga as
 * execuções anteriores); os workers herdam o caminho pela variável de ambiente.
 */
function e2eDataDir(): string {
  const existing = process.env.CYNO_E2E_DATA_DIR;
  if (existing) return existing;
  rmSync(E2E_ROOT, { recursive: true, force: true });
  mkdirSync(E2E_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(E2E_ROOT, "run-"));
  process.env.CYNO_E2E_DATA_DIR = dir;
  return dir;
}

/**
 * Ambiente do Chromium sem DISPLAY: numa sessão SSH com X11 (DISPLAY=localhost:10.0) o ANGLE tenta
 * Vulkan via XCB, falha, e o WebGL some. Headless não precisa de X.
 */
function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (key !== "DISPLAY" && value !== undefined) env[key] = value;
  return env;
}

const serverEnv = {
  PORT: String(SERVER_PORT),
  DATA_DIR: e2eDataDir(),
  // Modo simulado (só e2e): sem isto o servidor só tem agentes e Maestro reais.
  AGENT_RUNNER: "mock",
  MOCK_MIN_MS: "50",
  MOCK_MAX_MS: "150",
  // Aprovação só quando o pedido tem "[aprovar]" (sem sorteio): e2e determinístico.
  MOCK_APPROVAL_RATE: "0",
  LOG_LEVEL: "warn",
  // Só testes: sem senha o app fica aberto (sem a configuração inicial pelo código do log).
  CYNO_AUTH: "off",
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        headless: true,
        // WebGL por software (SwiftShader) sem o aviso de "fallback automático" no console.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"], env: browserEnv() },
      },
    },
    // Opcional, desligado por padrão (E2E_FIREFOX=1 npx playwright test --project=firefox e2e/cidade-tela-cheia.spec.ts): o Firefox do
    // Playwright (`npx playwright install firefox`) para conferir a tela cheia fora do Chromium. No Linux ele pede bibliotecas do sistema.
    ...(process.env.E2E_FIREFOX === "1" ? [{ name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 }, headless: true, launchOptions: { env: browserEnv() } } }] : []),
  ],
  webServer: [
    {
      command: "npm run start -w @cyno/server",
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev -w @cyno/web",
      url: `http://127.0.0.1:${WEB_PORT}`,
      // Sem HTTPS nos testes: o baseURL é http e o certificado autoassinado só atrapalharia.
      env: { PORT: String(SERVER_PORT), WEB_PORT: String(WEB_PORT), WEB_HOST: "127.0.0.1", WEB_HTTPS: "0" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
