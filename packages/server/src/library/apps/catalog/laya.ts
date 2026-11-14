import type { CatalogApp } from "@cyno/shared";

/**
 * Laya (NandhaKishorM/laya): motor de decisão "System 1" (sim/não, escolha entre opções e nota
 * sobre um texto, numa só passada do modelo, sem gastar token de LLM). Conferido em 11/11/2026:
 * `laya 0.4.31` no PyPI (Apache-2.0, Python 3.10+; o repositório lista 3.10 a 3.13, por isso o
 * Python 3.12 do uv), extra `mcp`, comando `laya-mcp-server` (stdio) com as ferramentas
 * `laya_status`, `laya_route`, `laya_predict`, `laya_predict_batch`, `laya_decide`... O `torch`
 * vem pela roda de CPU (`--torch-backend cpu`); os pesos (cerca de 800 MB) são baixados do
 * Hugging Face na primeira chamada, para a pasta do app (HF_HOME).
 */
export const laya: CatalogApp = {
  id: "laya",
  name: "Laya",
  area: "decisao",
  status: "disponivel",
  summary: "Decide pequenas perguntas sobre um texto (sim ou não, qual categoria, que nota) com um modelo local, em meio segundo e sem gastar token do agente.",
  useWhen: "o agente precisa de decisões rápidas sobre texto: é urgente, qual categoria, isso é seguro, o usuário quer cancelar",
  repo: "https://github.com/NandhaKishorM/laya",
  version: { kind: "pypi", ref: "laya 0.4.31 (torch 2.15 para CPU)" },
  recipeVersion: "1",
  license: { spdx: "Apache-2.0", level: "livre", url: "https://github.com/NandhaKishorM/laya/blob/main/LICENSE", mustAccept: false },
  warnings: [
    "Pesado: usa cerca de 2,1 GB de RAM enquanto está em uso (o processo para sozinho depois de 2 minutos parado) e cerca de 2 GB de disco.",
    "Na primeira chamada baixa o modelo (uns 800 MB) do Hugging Face e leva em torno de meio minuto; as seguintes levam menos de um segundo.",
    "Os números de velocidade e acerto vêm do próprio projeto; serve para decisões simples, não para responder perguntas abertas.",
  ],
  requires: [
    { kind: "python", spec: ">=3.12", provision: "uv-python", note: "o Python vem do uv, baixado para a pasta de runtimes" },
    { kind: "disk", spec: "2600MB" },
    { kind: "ram", spec: "2200MB", note: "com o modelo carregado" },
    { kind: "gpu", spec: "não precisa", note: "roda na CPU" },
  ],
  recipe: [
    { run: "download-runtime", runtime: "uv", label: "Baixar o uv (instala o Python e os pacotes)" },
    { run: "venv", python: "3.12", label: "Criar o ambiente Python do app" },
    { run: "pip-install", packages: ["laya[mcp]==0.4.31"], torchBackend: "cpu", timeoutSec: 1800, label: "Instalar o Laya e o PyTorch para CPU" },
  ],
  provides: {
    connector: {
      name: "Laya",
      description: "Decisões rápidas sobre um texto (sim/não, escolha, nota) com um modelo local. Use laya_predict com state e questions.",
      command: [".venv/bin/laya-mcp-server"],
      env: { LAYA_DEVICE: "cpu", LAYA_PRELOAD: "0", LAYA_THREADS: "4" },
      limits: { idleSec: 120, startSec: 90, callSec: 600 },
      expectTools: ["laya_predict", "laya_status"],
    },
  },
  test: {
    tool: "laya_predict",
    args: { state: { body: "Please cancel my subscription today, I am leaving." }, questions: { wants_to_cancel: { type: "noul", instructions: "Does the user want to cancel?" } } },
    expect: { matches: "\"noul\":\\s*[01](\\.\\d+)?" },
    timeoutSec: 600,
  },
  resources: { ramMB: 2200, diskMB: 2100, note: "Ambiente com PyTorch (cerca de 1 GB) mais o modelo (cerca de 800 MB) e o cache de instalação." },
};
