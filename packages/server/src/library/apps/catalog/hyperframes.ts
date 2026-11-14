import { catalogAppSchema, type CatalogApp } from "@cyno/shared";

/**
 * HyperFrames (HeyGen): vídeo escrito em HTML + GSAP, renderizado quadro a quadro pelo Chrome sem tela.
 * Receita conferida em 11/11/2026 no repositório https://github.com/heygen-com/hyperframes:
 * - pacote npm `hyperframes@0.9.33` (binário `hyperframes`, Node >=22; tag `v0.9.33` = commit e596be16…);
 * - o MCP do repositório (`server.json`) é HOSPEDADO pela HeyGen (mcp.heygen.com, conta HeyGen): não usamos.
 *   O caminho local é CLI + skills, então o app entra pelo conector `app` (ferramentas do AppToolRunner);
 * - o Chrome Headless Shell que ele baixaria sozinho vem em .zip e ele pede `unzip` (a máquina não tem):
 *   usamos o runtime `chrome` da plataforma (mesma versão que o HyperFrames fixa) via HYPERFRAMES_BROWSER_PATH;
 * - sem telemetria (HYPERFRAMES_NO_TELEMETRY, DO_NOT_TRACK), sem checagem de atualização, sem instalar skills em ~/.claude.
 * - `gsap` fica instalado no app para o projeto do mini teste não depender de CDN.
 */
const HF_VERSION = "0.9.33";
const HF_COMMIT = "e596be16c901639ce6c18032e56924a9d8e1967d";

/** Ambiente das ferramentas: runtimes da plataforma, caches dentro da pasta do app, sem telemetria nem checagem de atualização. */
const HF_ENV = {
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_SKIP_SKILLS: "1",
  DO_NOT_TRACK: "1",
  // CI: a CLI não deixa um Chrome "aquecido" rodando 5 min depois do `check` (processo solto, fora do nosso grupo).
  CI: "1",
  HYPERFRAMES_CONFIG_DIR: "{app}/.cache/hyperframes-config",
  HYPERFRAMES_CACHE_DIR: "{app}/.cache/hyperframes",
  HYPERFRAMES_FFMPEG_PATH: "{runtimes}/ffmpeg/bin/ffmpeg",
  HYPERFRAMES_FFPROBE_PATH: "{runtimes}/ffmpeg/bin/ffprobe",
  HYPERFRAMES_BROWSER_PATH: "{runtimes}/chrome/chrome-headless-shell/chrome-headless-shell",
};

/** Ruído do andamento da CLI: barras, rastros e contagem do `check`; o agente só precisa do resultado. */
const HF_QUIET = ["^\\[hyperframes\\] check: craft \\d+/\\d+$", "^@hf-progress ", "^[█░▒ ]+\\d+%", "^\\[INFO\\] \\[Render", "^\\[hyperframes\\] snapshot: frame \\d+/\\d+"];

const TEST_PROJECT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="../node_modules/gsap/dist/gsap.min.js"></script>
    <style>
      html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; background: #101820; }
      #root { width: 1080px; height: 1920px; display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
      #t { color: #ffffff; font-size: 120px; font-weight: 700; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="1080" data-height="1920">
      <h1 id="t" class="clip" data-start="0" data-duration="1" data-track-index="0">Cyno</h1>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#t", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

const NOTES_SKILL = `---
name: hyperframes-on-cyno
description: Read FIRST when you make a video with HyperFrames here. You have no shell: use the hyperframes__ tools (init_project, check_project, snapshot_frames, render_video) instead of "npx hyperframes". Says how the official HyperFrames skills map to those tools, the workflow, and this machine's limits.
---

# HyperFrames on this platform

You have **no shell**. The official skills (\`hyperframes\`, \`hyperframes-cli\`, \`hyperframes-registry\`) tell you to run \`npx hyperframes ...\`; here you call the connector tools instead. Use the skills for the *craft* (the composition contract, motion, layout, captions); use the tools to run things.

| Official skill says | You call |
| --- | --- |
| \`npx hyperframes init <dir> --skip-skills\` | \`hyperframes__init_project\` (dir, format) |
| \`npx hyperframes check\` / \`lint\` | \`hyperframes__check_project\` (project_dir) |
| \`npx hyperframes snapshot --at ...\` | \`hyperframes__snapshot_frames\` (project_dir, at) |
| \`npx hyperframes render\` | \`hyperframes__render_video\` (project_dir, output, title) |
| \`preview\`, \`open\`, \`publish\`, \`share\`, \`capture\`, \`catalog\`, \`add\`, HeyGen media, "Framey", the desktop app, the usage beacon | **Not available. Skip them.** Do not offer the preview or the desktop app to the user. |

## Workflow for a short video (e.g. a vertical post)

1. \`init_project\` with a NEW folder inside your own folder (for example \`video-cyno\`) and \`format: "portrait"\` for 1080x1920 (\`landscape\` 1920x1080, \`square\` 1080x1080). It writes \`index.html\` plus an \`AGENTS.md\` you can read.
2. Edit \`index.html\` (and \`compositions/\` if you split scenes) with your normal file tools. Follow the \`hyperframes\` skill contract: every timed element has \`class="clip"\`, \`data-start\`, \`data-duration\`; one paused GSAP timeline registered as \`window.__timelines["main"]\`; the root \`data-duration\` is the video length in seconds; no \`Date.now()\`, no random, no network fetches at run time.
3. \`check_project\` and fix every error it reports.
4. \`snapshot_frames\` with \`at\` like \`"0.5,3,9"\`: it writes PNGs and prints their paths. **Open them with your image reader and look**: text readable, nothing cut off the edges, nothing overlapping by accident. Fix and snapshot again.
5. \`render_video\` with \`project_dir\`, \`output\` (a new \`.mp4\` path inside your folder, e.g. \`video-cyno/out.mp4\`) and a short \`title\` in Brazilian Portuguese. When it succeeds the MP4 is already saved in the workspace media library and the reply carries the media id. Tell the user that id and what the video shows.

## This machine

- 4 CPU cores, no GPU, one render at a time for the whole platform (renders queue; yours may wait). A simple 10 s video at 1080x1920 renders in about 15 s and a 30 s one in about 30 s; heavy scenes (blur, shadows, many layers) take several times longer. Keep videos under about 30 s unless asked for more.
- Keep scenes light: no huge blurs or box-shadows, no full-screen video layers, no WebGL. Prefer solid colors, gradients, text and simple shapes with GSAP transforms and opacity.
- Use the bundled fonts named in \`references/format.md\`. Write the on-screen text in the user's language (Brazilian Portuguese) with correct accents.
- Local assets go in \`assets/\` inside the project. Everything you write stays inside your own folder.
`;

/** Validada na carga pelo mesmo esquema do catálogo (os padrões do esquema completam a entrada). */
export const hyperframes: CatalogApp = catalogAppSchema.parse({
  id: "hyperframes",
  name: "HyperFrames",
  area: "video",
  status: "disponivel",
  summary: "Cria vídeos escrevendo HTML com animações (GSAP) e renderiza em MP4 com o Chrome sem tela. O agente monta o projeto, confere, olha os quadros e renderiza; o vídeo cai na Mídia do workspace.",
  useWhen: "o dono quer um vídeo curto, animação de título, vídeo vertical para post ou explicador feito por código",
  repo: "https://github.com/heygen-com/hyperframes",
  version: { kind: "npm", ref: `hyperframes ${HF_VERSION}` },
  recipeVersion: "1",
  license: { spdx: "Apache-2.0", level: "livre", url: "https://github.com/heygen-com/hyperframes/blob/main/LICENSE", mustAccept: false },
  warnings: [
    "Renderizar pesa: o Chrome sem tela usa 2 dos 4 núcleos e cerca de 1,5 GB de RAM enquanto o vídeo sai. A plataforma roda um render por vez (os outros esperam na fila) e com prioridade baixa.",
    "A ferramenta roda comandos do app dentro da pasta do agente que a chamou; ela não lê nem grava fora dela. O HyperFrames baixa fontes do Google Fonts na primeira vez que um vídeo as usa (precisa de internet).",
    "Sem telemetria, sem conta HeyGen: só a CLI local. Recursos que dependem da HeyGen (avatar, voz, mídia gerada) não estão disponíveis.",
  ],
  requires: [
    { kind: "node", spec: ">=22" },
    { kind: "binary", spec: "ffmpeg>=6.1", provision: "static-ffmpeg", note: "ffmpeg estático, baixado para a pasta de runtimes" },
    { kind: "chrome", spec: "Chrome Headless Shell", provision: "self-download", note: "baixado para a pasta de runtimes (compartilhado com o Remotion)" },
    { kind: "ram", spec: "1500MB" },
    { kind: "disk", spec: "850MB" },
  ],
  recipe: [
    { run: "download-runtime", runtime: "ffmpeg", label: "Baixar o ffmpeg estático (compartilhado)" },
    { run: "download-runtime", runtime: "chrome", label: "Baixar o Chrome Headless Shell (compartilhado)" },
    { run: "npm-install", packages: [`hyperframes@${HF_VERSION}`, "gsap@3.15.0"], timeoutSec: 600, label: `Instalar o HyperFrames ${HF_VERSION}` },
    { run: "git-clone", repo: "https://github.com/heygen-com/hyperframes", ref: HF_COMMIT, to: "src", sparse: ["skills"], timeoutSec: 600, label: "Baixar as skills oficiais (só a pasta skills)" },
    { run: "write-file", to: "test/index.html", content: TEST_PROJECT, label: "Escrever o projeto do mini teste" },
    { run: "write-file", to: "cyno/hyperframes-on-cyno/SKILL.md", content: NOTES_SKILL, label: "Escrever a skill de uso nesta plataforma" },
  ],
  provides: {
    connector: {
      kind: "app",
      queueGroup: "video-render",
      name: "HyperFrames",
      description: "Cria vídeo a partir de HTML: inicia o projeto, confere, tira quadros para olhar e renderiza em MP4 (vai para a Mídia).",
      env: {},
      expectTools: ["init_project", "check_project", "snapshot_frames", "render_video"],
      tools: [
        {
          name: "init_project",
          description: "Creates a new HyperFrames video project (index.html, hyperframes.json, AGENTS.md) in a NEW folder inside your own folder. Edit index.html afterwards with your file tools.",
          params: [
            { type: "path", name: "dir", description: "Folder to create, e.g. video-cyno.", must: "new-dir" },
            { type: "enum", name: "format", description: "Canvas: portrait 1080x1920, landscape 1920x1080 or square 1080x1080.", values: ["portrait", "landscape", "square"], default: "portrait", optional: true },
          ],
          command: ["node_modules/.bin/hyperframes", "init", "{dir}", "--non-interactive", "--skip-skills", "--skip-transcribe", "--resolution", "{format}"],
          timeoutSec: 120,
          env: HF_ENV,
        },
        {
          name: "check_project",
          description: "Runs HyperFrames lint + runtime + layout checks on a project (what `hyperframes check` does). Returns the findings, each with a Fix line. Fix every error before rendering.",
          params: [{ type: "path", name: "project_dir", description: "The project folder (has index.html).", must: "exist-dir" }],
          command: ["node_modules/.bin/hyperframes", "check", "{project_dir}"],
          cwd: "param:project_dir",
          timeoutSec: 300,
          env: HF_ENV,
          quiet: HF_QUIET,
        },
        {
          name: "snapshot_frames",
          description: "Captures PNG frames of the composition at the given seconds so you can LOOK at them with your image reader before rendering. The reply lists the PNG paths (inside the project folder).",
          params: [
            { type: "path", name: "project_dir", description: "The project folder (has index.html).", must: "exist-dir" },
            { type: "string", name: "at", description: 'Comma-separated seconds, e.g. "0.5,3,9" (up to 8 values).', pattern: "^[0-9]+(\\.[0-9]+)?(,[0-9]+(\\.[0-9]+)?){0,7}$", maxLength: 80 },
          ],
          command: ["node_modules/.bin/hyperframes", "snapshot", "{project_dir}", "--at={at}"],
          cwd: "param:project_dir",
          timeoutSec: 300,
          env: HF_ENV,
          quiet: HF_QUIET,
        },
        {
          name: "render_video",
          description:
            "Renders a HyperFrames project to an MP4 and saves it in the workspace media library (the reply carries the media id). One render runs at a time on the whole machine, so it may wait in a queue; a simple 10 s 1080x1920 video renders in about 15 s and a 30 s one in about 30 s here (heavier scenes take longer). Check the project and look at snapshots first.",
          params: [
            { type: "path", name: "project_dir", description: "The project folder (has index.html).", must: "exist-dir" },
            { type: "path", name: "output", description: "The MP4 to create, e.g. video-cyno/out.mp4.", must: "new-file", ext: [".mp4"] },
            { type: "string", name: "title", description: "Short title in Brazilian Portuguese, shown in the media library.", optional: true, maxLength: 80 },
            { type: "integer", name: "fps", description: "Frames per second (default 30).", optional: true, min: 12, max: 60 },
            { type: "enum", name: "quality", description: "draft (fast, rough), standard (default) or high (slow).", values: ["draft", "standard", "high"], default: "standard", optional: true },
          ],
          command: ["node_modules/.bin/hyperframes", "render", "{project_dir}", "-o", "{output}", "--quality", "{quality}", { if: "fps", args: ["--fps", "{fps}"] }, "--workers", "{workers}"],
          cwd: "param:project_dir",
          timeoutSec: 1800,
          env: HF_ENV,
          quiet: HF_QUIET,
          progress: { regex: '"pct":(?<pct>\\d+)' },
          output: { param: "output", kind: "video", title: "Vídeo do HyperFrames" },
        },
      ],
    },
    skills: [
      { from: "cyno/hyperframes-on-cyno", include: ["SKILL.md"] },
      { from: "src/skills/hyperframes", include: ["SKILL.md", "references/*.md", "references/types/*.md"] },
      { from: "src/skills/hyperframes-cli", include: ["SKILL.md", "references/*.md"] },
      { from: "src/skills/hyperframes-registry", include: ["SKILL.md", "references/*.md"] },
    ],
  },
  test: {
    tool: "render_video",
    args: { project_dir: "test", output: "test/out.mp4", fps: 30, quality: "draft" },
    expect: { matches: "^RENDERED file test/out\\.mp4 \\(1\\.\\d s, 1080x1920," },
    timeoutSec: 240,
  },
  resources: { ramMB: 1500, diskMB: 800, note: "Cerca de 205 MB na pasta do app, mais ffmpeg (330 MB) e Chrome (261 MB) em runtimes/, compartilhados com os outros apps de vídeo." },
});
