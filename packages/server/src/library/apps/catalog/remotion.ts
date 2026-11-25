import { catalogAppSchema, type CatalogApp } from "@cyno/shared";

/**
 * Remotion: vídeo escrito em React, renderizado quadro a quadro pelo Chrome sem tela. Receita conferida em
 * 11/11/2026 (https://github.com/remotion-dev/remotion e https://github.com/remotion-dev/skills):
 * - npm `remotion@4.0.542` + `@remotion/cli`/`renderer`/`bundler` (mesma versão) + `react@19.3.1`; o `@remotion/compositor`
 *   já traz o ffmpeg/ffprobe dele, mas a plataforma também instala o runtime ffmpeg (o ffprobe confere a saída);
 * - SEM MCP: o servidor MCP oficial foi desligado em 26/10/2026 (https://www.remotion.dev/docs/ai/mcp); o caminho é CLI + skills,
 *   então o app entra pelo conector `app`;
 * - o Chrome vem do runtime `chrome` da plataforma (a MESMA versão que o HyperFrames usa), por `--browser-executable`
 *   (a skill oficial `remotion-render` desaconselha, mas aqui o Chrome do Remotion seria baixado para ~/ ou node_modules);
 * - skills oficiais (`remotion-dev/skills`, commit fixado): create, render e markup (só os .md do nível de cima: a pasta
 *   inteira, com mapas e modelos, é pesada demais para entrar inteira);
 * - LICENÇA própria (https://github.com/remotion-dev/remotion/blob/main/LICENSE.md): grátis para pessoa e empresa de até 3
 *   pessoas; acima disso, licença paga. Só instala depois do "Li o aviso".
 * - `node_modules` do app não é visto por um projeto na pasta do agente: o script `bin/remotion-init.mjs` (escrito pela
 *   receita) cria o projeto e liga `node_modules` ao do app.
 */
const RM_VERSION = "4.0.542";
const RM_SKILLS_COMMIT = "1fc074b74b95cfecf7b1e419132f2cfe23dafebe";

const INIT_SCRIPT = `// Cria um projeto Remotion mínimo numa pasta NOVA e liga o node_modules do app (o projeto mora na pasta do agente).
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [dir, format = "portrait", id = "Main"] = process.argv.slice(2);
if (!dir) throw new Error("uso: remotion-init.mjs <pasta> [portrait|landscape|square] [id]");
const sizes = { portrait: [1080, 1920], landscape: [1920, 1080], square: [1080, 1080] };
const [width, height] = sizes[format] ?? sizes.portrait;
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await mkdir(path.join(dir, "src"), { recursive: true });
await symlink(path.join(appDir, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "video", private: true }, null, 2) + "\\n");
await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true } }, null, 2) + "\\n");
await writeFile(path.join(dir, "src", "index.ts"), 'import { registerRoot } from "remotion";\\nimport { Root } from "./Root";\\n\\nregisterRoot(Root);\\n');
await writeFile(
  path.join(dir, "src", "Root.tsx"),
  \`import React from "react";
import { AbsoluteFill, Composition, interpolate, useCurrentFrame } from "remotion";

type Props = { title: string };

const Scene: React.FC<Props> = ({ title }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0b1020", alignItems: "center", justifyContent: "center" }}>
      <h1 style={{ color: "white", fontSize: 120, fontFamily: "sans-serif", opacity }}>{title}</h1>
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => (
  <Composition id="\${id}" component={Scene} durationInFrames={150} fps={30} width={\${width}} height={\${height}} defaultProps={{ title: "Olá" }} />
);
\`,
);
console.log("Projeto criado em " + dir + " (composição \\"" + id + "\\", " + width + "x" + height + "). Edite src/Root.tsx.");
`;

const TEST_INDEX = `import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
`;

const TEST_ROOT = `import React from "react";
import { AbsoluteFill, Composition, interpolate, useCurrentFrame } from "remotion";

const Scene: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#101820", alignItems: "center", justifyContent: "center" }}>
      <h1 style={{ color: "white", fontSize: 120, fontFamily: "sans-serif", opacity }}>Cyno</h1>
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => <Composition id="Test" component={Scene} durationInFrames={30} fps={30} width={1080} height={1920} />;
`;

const NOTES_SKILL = `---
name: remotion-on-cyno
description: Read FIRST when you make a video with Remotion here. You have no shell: use the remotion__ tools (init_project, list_compositions, render_still, render_video) instead of "npx remotion" and "create-video". Says how the official Remotion skills map to those tools, the workflow, and this machine's limits.
---

# Remotion on this platform

You have **no shell**. The official skills (\`remotion-create\`, \`remotion-render\`, \`remotion-markup\`) tell you to run \`npx create-video\`, \`npm i\` and \`npx remotion render\`; here you call the connector tools instead. Use the skills for the *craft* (compositions, timing, layout, animation); use the tools to run things.

| Official skill says | You call |
| --- | --- |
| \`npx create-video@latest ...\` + \`npm i\` | \`remotion__init_project\` (dir, format, composition) |
| \`npx remotion compositions\` | \`remotion__list_compositions\` (project_dir) |
| \`npx remotion still ...\` | \`remotion__render_still\` (project_dir, composition, output, frame) |
| \`npx remotion render ...\` | \`remotion__render_video\` (project_dir, composition, output, title) |
| Studio / preview, \`npm run dev\`, \`remotion skills add\`, \`--browser-executable\` advice | **Not available / already handled.** Skip them: the platform supplies the Chrome and the dependencies. |

## Workflow for a short video

1. \`init_project\` with a NEW folder inside your own folder (for example \`video-cyno\`), a \`format\` (\`portrait\` 1080x1920, \`landscape\` 1920x1080, \`square\` 1080x1080) and the composition id. It writes \`package.json\`, \`tsconfig.json\`, \`src/index.ts\`, \`src/Root.tsx\` and links the installed Remotion packages. Do not run npm: nothing else needs installing, and you cannot add packages.
2. Edit \`src/Root.tsx\` (and add files in \`src/\`) with your normal file tools: React components with \`useCurrentFrame()\`, \`interpolate\`, \`<Sequence>\`, \`<AbsoluteFill>\`. Set \`durationInFrames\` = seconds x fps. Only the packages \`remotion\`, \`react\`, \`react-dom\`, \`@remotion/renderer\`, \`@remotion/bundler\`, \`@remotion/cli\` exist; do not import others.
3. \`list_compositions\` to confirm the project compiles and the composition is registered.
4. \`render_still\` for a few frames (e.g. frame 0, the middle, the last) into new \`.png\` paths in your folder, then **open the PNGs with your image reader and look**: text readable, nothing cut off, nothing overlapping by accident. Fix and repeat.
5. \`render_video\` with \`project_dir\`, \`composition\`, \`output\` (a new \`.mp4\` path in your folder) and a short \`title\` in Brazilian Portuguese. When it succeeds the MP4 is already saved in the workspace media library and the reply carries the media id. Tell the user that id and what the video shows.

## This machine

- 4 CPU cores, no GPU, one render at a time for the whole app (renders queue; yours may wait). The first render of a project bundles it (about 15-30 s extra). Measured here: a 10 s 1080x1920 video takes 25-70 s and a 30 s one about a minute, depending on the scene (glows and blurs are the slow part). Keep videos under about 30 s unless asked for more.
- Keep scenes light: avoid heavy blur/shadow filters, WebGL/three.js and big video layers. Text, gradients, shapes and \`interpolate\`/\`spring\` animations are cheap.
- Fonts: system sans-serif, or a font file you put in \`public/\` and load with \`@remotion/fonts\`-style CSS \`@font-face\` (no extra packages). Write the on-screen text in the user's language (Brazilian Portuguese) with correct accents.
- Everything you write stays inside your own folder. License: Remotion is free for individuals and companies up to 3 people; the owner accepted that when installing.
`;

/** Validada na carga pelo mesmo esquema do catálogo. */
export const remotion: CatalogApp = catalogAppSchema.parse({
  id: "remotion",
  name: "Remotion",
  area: "video",
  status: "disponivel",
  summary: "Cria vídeos escrevendo componentes React e renderiza em MP4 com o Chrome sem tela. O agente monta o projeto, olha os quadros e renderiza; o vídeo cai na Mídia do workspace.",
  useWhen: "o dono quer um vídeo feito com React/Remotion (mais controle por código que o HyperFrames)",
  repo: "https://github.com/remotion-dev/remotion",
  version: { kind: "npm", ref: `remotion ${RM_VERSION}` },
  recipeVersion: "1",
  license: {
    spdx: "Remotion License",
    level: "restrita",
    notice: "A licença do Remotion não é livre: é grátis para pessoas e empresas de até 3 funcionários (uso comercial incluso); empresa com 4 ou mais pessoas precisa de licença paga (a partir de US$ 100 por mês se automatizar renders). Você é uma pessoa, então vale o grátis; confira em remotion.pro/license se isso mudar. Vender um produto derivado do Remotion é proibido.",
    url: "https://github.com/remotion-dev/remotion/blob/main/LICENSE.md",
    mustAccept: true,
  },
  warnings: [
    "Licença com aviso: grátis para pessoas e empresas até 3 funcionários; acima disso, paga. O HyperFrames (Apache-2.0) faz o mesmo sem essa restrição.",
    "Renderizar pesa: o Chrome sem tela usa 2 dos 4 núcleos e cerca de 1,5 GB de RAM; um render por vez (os outros esperam na fila), com prioridade baixa.",
    "O repositório de skills do Remotion não traz arquivo de licença; elas são material oficial dele e ficam só para uso aqui, em modo leitura.",
  ],
  requires: [
    { kind: "node", spec: ">=22" },
    { kind: "binary", spec: "ffmpeg>=6.1", provision: "static-ffmpeg", note: "ffmpeg estático, baixado para a pasta de runtimes" },
    { kind: "chrome", spec: "Chrome Headless Shell", provision: "self-download", note: "baixado para a pasta de runtimes (compartilhado com o HyperFrames)" },
    { kind: "ram", spec: "1500MB" },
    { kind: "disk", spec: "1300MB" },
  ],
  recipe: [
    { run: "download-runtime", runtime: "ffmpeg", label: "Baixar o ffmpeg estático (compartilhado)" },
    { run: "download-runtime", runtime: "chrome", label: "Baixar o Chrome Headless Shell (compartilhado)" },
    { run: "npm-install", packages: [`remotion@${RM_VERSION}`, `@remotion/cli@${RM_VERSION}`, `@remotion/renderer@${RM_VERSION}`, `@remotion/bundler@${RM_VERSION}`, "react@19.3.1", "react-dom@19.3.1"], timeoutSec: 900, label: `Instalar o Remotion ${RM_VERSION}` },
    { run: "git-clone", repo: "https://github.com/remotion-dev/skills", ref: RM_SKILLS_COMMIT, to: "src", sparse: ["skills"], timeoutSec: 600, label: "Baixar as skills oficiais (remotion-dev/skills)" },
    { run: "write-file", to: "bin/remotion-init.mjs", content: INIT_SCRIPT, label: "Escrever o script que cria projetos" },
    { run: "write-file", to: "test/remotion/src/index.ts", content: TEST_INDEX, label: "Escrever o projeto do mini teste" },
    { run: "write-file", to: "test/remotion/src/Root.tsx", content: TEST_ROOT, label: "Escrever a composição do mini teste" },
    { run: "write-file", to: "cyno/remotion-on-cyno/SKILL.md", content: NOTES_SKILL, label: "Escrever a skill de uso nesta plataforma" },
  ],
  provides: {
    connector: {
      kind: "app",
      queueGroup: "video-render",
      name: "Remotion",
      description: "Cria vídeo a partir de React: inicia o projeto, lista as composições, tira quadros para olhar e renderiza em MP4 (vai para a Mídia).",
      env: {},
      expectTools: ["init_project", "list_compositions", "render_still", "render_video"],
      tools: [
        {
          name: "init_project",
          description: "Creates a new Remotion project (package.json, tsconfig.json, src/index.ts, src/Root.tsx) in a NEW folder inside your own folder and links the installed Remotion packages, so nothing needs npm install. Edit src/Root.tsx afterwards with your file tools.",
          params: [
            { type: "path", name: "dir", description: "Folder to create, e.g. video-cyno.", must: "new-dir" },
            { type: "enum", name: "format", description: "Canvas: portrait 1080x1920, landscape 1920x1080 or square 1080x1080.", values: ["portrait", "landscape", "square"], default: "portrait", optional: true },
            { type: "string", name: "composition", description: "Composition id (letters, digits, dashes). Default Main.", pattern: "^[A-Za-z][A-Za-z0-9-]{0,40}$", default: "Main", optional: true, maxLength: 40 },
          ],
          command: ["{node}", "bin/remotion-init.mjs", "{dir}", "{format}", "{composition}"],
          timeoutSec: 60,
        },
        {
          name: "list_compositions",
          description: "Bundles the project and lists its registered compositions (id, size, fps, duration). Use it to confirm the project compiles and to get the composition id.",
          params: [{ type: "path", name: "project_dir", description: "The project folder (has src/index.ts).", must: "exist-dir" }],
          command: ["node_modules/.bin/remotion", "compositions", "{project_dir}/src/index.ts", "--browser-executable={runtimes}/chrome/chrome-headless-shell/chrome-headless-shell", "--log=info"],
          cwd: "param:project_dir",
          timeoutSec: 300,
          env: { REMOTION_NO_TELEMETRY: "1" },
          quiet: ["^Bundling", "^\\(\\d/\\d\\)"],
        },
        {
          name: "render_still",
          description: "Renders ONE frame of a composition to a PNG so you can LOOK at it with your image reader before rendering the video. Not saved to the media library.",
          params: [
            { type: "path", name: "project_dir", description: "The project folder (has src/index.ts).", must: "exist-dir" },
            { type: "string", name: "composition", description: "Composition id.", pattern: "^[A-Za-z][A-Za-z0-9-]{0,40}$", maxLength: 40 },
            { type: "path", name: "output", description: "The PNG to create, e.g. video-cyno/frame-0.png.", must: "new-file", ext: [".png"] },
            { type: "integer", name: "frame", description: "Frame number (0 = first). Default 0.", min: 0, max: 20000, default: 0, optional: true },
          ],
          command: ["node_modules/.bin/remotion", "still", "{project_dir}/src/index.ts", "{composition}", "{output}", "--frame={frame}", "--overwrite", "--browser-executable={runtimes}/chrome/chrome-headless-shell/chrome-headless-shell", "--log=info"],
          cwd: "param:project_dir",
          timeoutSec: 300,
          env: { REMOTION_NO_TELEMETRY: "1" },
          quiet: ["^Bundling", "^\\(\\d/\\d\\)"],
        },
        {
          name: "render_video",
          description:
            "Renders a composition of a Remotion project to an MP4 and saves it in the workspace media library (the reply carries the media id). One render runs at a time on the whole machine, so it may wait in a queue; the first render of a project also bundles it. Measured here: 10 s takes 25-70 s and 30 s about a minute, depending on the scene. Look at stills first.",
          params: [
            { type: "path", name: "project_dir", description: "The project folder (has src/index.ts).", must: "exist-dir" },
            { type: "string", name: "composition", description: "Composition id (see list_compositions).", pattern: "^[A-Za-z][A-Za-z0-9-]{0,40}$", maxLength: 40 },
            { type: "path", name: "output", description: "The MP4 to create, e.g. video-cyno/out.mp4.", must: "new-file", ext: [".mp4"] },
            { type: "string", name: "title", description: "Short title in Brazilian Portuguese, shown in the media library.", optional: true, maxLength: 80 },
            { type: "string", name: "props_json", description: "Optional JSON object with input props for the composition, e.g. {\"title\":\"Oi\"}.", optional: true, maxLength: 4000 },
            { type: "integer", name: "crf", description: "x264 quality, lower = better and slower (default 18; 28 is a fast draft).", min: 1, max: 40, default: 18, optional: true },
          ],
          command: [
            "node_modules/.bin/remotion",
            "render",
            "{project_dir}/src/index.ts",
            "{composition}",
            "{output}",
            "--overwrite",
            "--concurrency={workers}",
            { if: "props_json", args: ["--props={props_json}"] },
            "--crf={crf}",
            "--browser-executable={runtimes}/chrome/chrome-headless-shell/chrome-headless-shell",
            "--log=info",
          ],
          cwd: "param:project_dir",
          timeoutSec: 1800,
          env: { REMOTION_NO_TELEMETRY: "1" },
          progress: { regex: "Rendered (?<done>\\d+)/(?<total>\\d+)" },
          quiet: ["^Rendered \\d+/\\d+", "^Encoded \\d+/\\d+", "^Bundling", "^\\(\\d/\\d\\)"],
          output: { param: "output", kind: "video", title: "Vídeo do Remotion" },
        },
      ],
    },
    skills: [
      { from: "cyno/remotion-on-cyno", include: ["SKILL.md"] },
      { from: "src/skills/remotion-create", include: ["SKILL.md", "*.md"] },
      { from: "src/skills/remotion-render", include: ["SKILL.md", "*.md"] },
      { from: "src/skills/remotion-markup", include: ["SKILL.md", "*.md"] },
    ],
  },
  test: {
    tool: "render_video",
    args: { project_dir: "test/remotion", composition: "Test", output: "test/out.mp4", crf: 28 },
    expect: { matches: "^RENDERED file test/out\\.mp4 \\(1\\.\\d s, 1080x1920," },
    timeoutSec: 300,
  },
  resources: { ramMB: 1500, diskMB: 750, note: "Cerca de 710 MB na pasta do app (490 MB de node_modules e o resto de cache do npm e do empacotador, que cresce com o uso), mais ffmpeg (330 MB) e Chrome (261 MB) em runtimes/, compartilhados com o HyperFrames." },
});
