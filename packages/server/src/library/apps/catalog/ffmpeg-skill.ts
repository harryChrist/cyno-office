import { catalogAppSchema, type CatalogApp } from "@cyno/shared";

/**
 * ffmpeg-skill (kajisho5, MIT): editor de vídeo local para agentes (cortar, juntar, reenquadrar, legendar, áudio,
 * loudness, checagem de entrega). Receita conferida em 11/11/2026 em https://github.com/kajisho5/ffmpeg-skill:
 * - tag `v3.4.3` = commit 32e33557…; o MCP é `mcp/server.py` (stdio, JSON-RPC, SÓ biblioteca padrão do Python), com 12
 *   ferramentas por padrão (`probe`, `cut`, `fit`, `caption`, `audio`, `silence`, `loudness`, `check`, `export`, `look`,
 *   `graphics`, `render`) e 42 com `FFMPEG_SKILL_MCP_FULL=1`;
 * - NÃO usamos `npx ffmpeg-skill` (o instalador dele escreve em `~/.claude`): clonamos o commit fixado dentro da pasta do
 *   app e o conector stdio roda `.venv/bin/python {app}/src/mcp/server.py` (`{app}` = a pasta do app, caminho inteiro porque o MCP roda em outra pasta) (Python 3.12 do uv) com o ffmpeg dos runtimes no PATH;
 * - o MCP é utilizável como está, então NÃO foi preciso expor operações pelo conector `app`. Contrapartida: ele recebe
 *   caminho de qualquer lugar (sem a jaula da pasta do agente) e não grava na Mídia; por isso o aviso na janela e a skill
 *   nossa, que manda usar caminhos absolutos da pasta do agente e `media_save_file` no fim.
 */
const FF_COMMIT = "32e3355795d53c897ef804b6bcce2cda83cdd958";

const NOTES_SKILL = `---
name: ffmpeg-skill-on-cyno
description: Read FIRST when you edit video or audio with ffmpeg-skill here. You have no shell: call the ffmpeg-skill__ tools (probe, cut, fit, caption, audio, silence, loudness, check, export, look, graphics, render) with ABSOLUTE paths inside your own folder, then save the result with media_save_file.
---

# ffmpeg-skill on this platform

You have **no shell**. The official \`ffmpeg-skill\` skill says "run \`python3 <skill-dir>/scripts/<name>.py\`"; here each script is a connector tool with the same name: \`ffmpeg-skill__probe\`, \`ffmpeg-skill__cut\`, \`ffmpeg-skill__fit\`, \`ffmpeg-skill__caption\`, \`ffmpeg-skill__audio\`, \`ffmpeg-skill__silence\`, \`ffmpeg-skill__loudness\`, \`ffmpeg-skill__check\`, \`ffmpeg-skill__export\`, \`ffmpeg-skill__look\`, \`ffmpeg-skill__graphics\`, \`ffmpeg-skill__render\`. The tool arguments are the script flags in snake_case (\`--aspect 9:16\` is \`aspect: "9:16"\`; the inputs of \`probe\` are \`inputs: ["<path>"]\`). Follow the official workflow (probe first, plan from real numbers, check the result) and read each tool's description for its arguments.

## Rules on this machine

- Use **absolute paths**, and only inside **your own folder** (your working directory). The tool runs in another directory, so a relative path will not find your files. Never read or write anywhere else.
- Write every output to a **new file name** in your folder (the tools refuse to overwrite a source). Keep the original.
- The tools run one after another on a 4-core machine with no GPU; a long re-encode can take minutes. Prefer stream copy (no re-encode) when a cut allows it.
- You cannot see pixels with a tool: use \`look\` to make a contact-sheet PNG and open it with your image reader.
- When the result is ready, save it to the workspace media library with \`media_save_file\` (path inside your folder, short title in Brazilian Portuguese) and tell the user the media id. Nothing reaches the library by itself.
- To make a video from scratch (titles, animation), use HyperFrames if it is available to you; ffmpeg-skill edits footage that already exists.

## Typical jobs

- **Cut the middle 5 s of a video:** \`probe\` for the duration, then \`cut\` with \`start\`, \`duration: "5"\` (or \`end\`) and an \`output\` path.
- **Vertical 9:16 version:** \`fit\` with \`aspect: "9:16"\`, \`fit: "crop"\` (or \`pad\`/\`blur\`) and an \`output\` path.
- **Audio only:** \`audio\` on the video with an \`.m4a\`/\`.mp3\`/\`.wav\` \`output\` (see its description for the extract option).
- **Burn subtitles:** write an \`.srt\` file in your folder, then \`caption\` with \`input\`, the srt and an \`output\` path.
- **Convert / deliver for a platform:** \`export\`; then \`check\` the file.
`;

/** Validada na carga pelo mesmo esquema do catálogo. */
export const ffmpegSkill: CatalogApp = catalogAppSchema.parse({
  id: "ffmpeg-skill",
  name: "ffmpeg-skill",
  area: "video",
  status: "disponivel",
  summary: "Edita vídeo e áudio com o ffmpeg: corta, junta, reenquadra (9:16), legenda, limpa o áudio e confere a entrega. São 12 ferramentas prontas para o agente, tudo local e sem chave de API.",
  useWhen: "o dono quer cortar, juntar, legendar, reenquadrar ou extrair o áudio de um vídeo que já existe",
  repo: "https://github.com/kajisho5/ffmpeg-skill",
  version: { kind: "git", ref: "ffmpeg-skill 3.4.3" },
  recipeVersion: "1",
  license: { spdx: "MIT", level: "livre", url: "https://github.com/kajisho5/ffmpeg-skill/blob/main/LICENSE", mustAccept: false },
  warnings: [
    "O servidor MCP deste app recebe caminhos de qualquer lugar da máquina (não há pasta presa como nos apps com ferramentas próprias do Cyno) e não grava na Mídia sozinho. Libere só para os agentes que precisam: a skill do app manda usar a pasta do agente e o media_save_file.",
    "Codificar vídeo pesa: roda no processador da máquina (4 núcleos, sem placa de vídeo) e um vídeo longo leva minutos.",
  ],
  requires: [
    { kind: "python", spec: ">=3.10", provision: "uv-python", note: "o Python vem do uv, baixado para a pasta de runtimes; o app só usa a biblioteca padrão" },
    { kind: "binary", spec: "ffmpeg>=6.1", provision: "static-ffmpeg", note: "ffmpeg estático (libx264, libass), baixado para a pasta de runtimes" },
    { kind: "disk", spec: "500MB" },
    { kind: "ram", spec: "300MB" },
  ],
  recipe: [
    { run: "download-runtime", runtime: "uv", label: "Baixar o uv (instala o Python)" },
    { run: "download-runtime", runtime: "ffmpeg", label: "Baixar o ffmpeg estático (compartilhado)" },
    { run: "venv", python: "3.12", label: "Criar o ambiente Python do app" },
    { run: "git-clone", repo: "https://github.com/kajisho5/ffmpeg-skill", ref: FF_COMMIT, to: "src", sparse: ["mcp", "scripts", "references"], timeoutSec: 600, label: "Baixar o ffmpeg-skill 3.4.3 (mcp, scripts e referências)" },
    { run: "write-file", to: "test/README.txt", content: "Arquivos do mini teste do ffmpeg-skill.\n", label: "Criar a pasta do mini teste" },
    { run: "exec", bin: "runtime:ffmpeg/bin/ffmpeg", args: ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=duration=1", "-shortest", "test/sample.mp4"], timeoutSec: 60, label: "Gerar 1 s de vídeo de teste com o ffmpeg dos runtimes" },
    { run: "write-file", to: "cyno/ffmpeg-skill-on-cyno/SKILL.md", content: NOTES_SKILL, label: "Escrever a skill de uso nesta plataforma" },
  ],
  provides: {
    connector: {
      kind: "stdio",
      name: "ffmpeg-skill",
      description: "Edita vídeo e áudio com o ffmpeg: probe, cut, fit, caption, audio, silence, loudness, check, export, look, graphics e render. Use caminhos absolutos da sua pasta.",
      command: [".venv/bin/python", "{app}/src/mcp/server.py"],
      env: { FFMPEG_SKILL_MCP_FULL: "0", PYTHONDONTWRITEBYTECODE: "1" },
      limits: { idleSec: 300, startSec: 30, callSec: 900 },
      expectTools: ["probe", "cut", "fit", "caption", "audio", "check"],
    },
    skills: [
      { from: "cyno/ffmpeg-skill-on-cyno", include: ["SKILL.md"] },
      { from: "src", include: ["SKILL.md", "references/workflow.md", "references/flags.md", "references/gotchas.md", "references/requests.md", "references/timestamps.md", "references/report.md", "references/devices.md"] },
    ],
  },
  test: { tool: "probe", args: { inputs: ["{app}/test/sample.mp4"] }, expect: { matches: '"duration": 1\\.0' }, timeoutSec: 60 },
  resources: { ramMB: 300, diskMB: 450, note: "Cerca de 10 MB do app, mais o ffmpeg (346 MB, compartilhado) e o Python do uv (compartilhado)." },
});
