import type { AppRuntimeId } from "@cyno/shared";

/**
 * Runtimes compartilhados que a plataforma baixa sozinha para `data/platform/runtimes/<id>/`
 * (sem sudo, nada no sistema). Cada binário tem o sha256 fixado; o arquivo baixado só vale se bater.
 */
export type RuntimeTarget = { url: string; sha256: string; sizeMB: number };
export type RuntimeDef = {
  id: AppRuntimeId;
  label: string;
  version: string;
  /** Chave "<os>-<arch>" -> arquivo. */
  targets: Record<string, RuntimeTarget>;
  /** Binário principal, relativo à pasta do runtime. */
  bin: string;
  /** Formato do arquivo baixado. */
  archive: "tar.gz" | "tar.xz" | "zip";
  /** Pastas de nível único que o pacote traz e que saem do caminho (`tar --strip-components`; no zip, igual). */
  strip: number;
  /** Onde os arquivos extraídos ficam, dentro da pasta do runtime. */
  into: string;
  /** Só estes caminhos do pacote (padrões do tar); vazio = tudo. */
  only?: string[];
};

const UV_VERSION = "0.13.7";
const uvUrl = (triple: string) => `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz`;

/**
 * ffmpeg estático (BtbN/FFmpeg-Builds, build GPL com libx264, libass e drawtext) do lançamento mensal
 * `autobuild-2026-10-31-12-59` (o projeto guarda essa tag; o `latest` muda todo dia). Só o ffmpeg e o
 * ffprobe saem do pacote. O sha256 é o que o GitHub publica para o arquivo.
 */
const FFMPEG_VERSION = "8.1.3";
const FFMPEG_RELEASE = "autobuild-2026-10-31-12-59";
const FFMPEG_BUILD = "n8.1.3-27-g8dca1586f4";
const ffmpegUrl = (arch: "linux64" | "linuxarm64") => `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/ffmpeg-${FFMPEG_BUILD}-${arch}-gpl-8.1.tar.xz`;

/**
 * Chrome Headless Shell (Chrome for Testing) na versão que o HyperFrames fixa; os dois apps de vídeo usam
 * o mesmo. O pacote é .zip e a máquina não tem `unzip`: o instalador descompacta sozinho.
 */
const CHROME_VERSION = "152.0.7977.30";
const chromeUrl = (platform: "linux64") => `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`;

export const RUNTIMES: Record<AppRuntimeId, RuntimeDef> = {
  uv: {
    id: "uv",
    label: `uv ${UV_VERSION} (instala o Python e os pacotes dos apps)`,
    version: UV_VERSION,
    bin: "bin/uv",
    archive: "tar.gz",
    strip: 1,
    into: "bin",
    targets: {
      "linux-x64": { url: uvUrl("x86_64-unknown-linux-gnu"), sha256: "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83", sizeMB: 22 },
      "linux-arm64": { url: uvUrl("aarch64-unknown-linux-gnu"), sha256: "71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc", sizeMB: 21 },
    },
  },
  ffmpeg: {
    id: "ffmpeg",
    label: `ffmpeg ${FFMPEG_VERSION} estático (corta, junta e codifica vídeo; o ffprobe confere o resultado)`,
    version: `${FFMPEG_VERSION} (${FFMPEG_BUILD})`,
    bin: "bin/ffmpeg",
    archive: "tar.xz",
    strip: 2,
    into: "bin",
    only: ["*/bin/ffmpeg", "*/bin/ffprobe"],
    targets: {
      "linux-x64": { url: ffmpegUrl("linux64"), sha256: "41e9c565594c390622cf968d82fa4135d9e9a11d06c1515644288cbc844e3380", sizeMB: 152 },
      "linux-arm64": { url: ffmpegUrl("linuxarm64"), sha256: "a08c0ee6e1c4e02139344b303002dcc7c37cf125d639f1fbd15dabee40fcb525", sizeMB: 128 },
    },
  },
  chrome: {
    id: "chrome",
    label: `Chrome Headless Shell ${CHROME_VERSION} (o navegador sem tela que renderiza os vídeos)`,
    version: CHROME_VERSION,
    bin: "chrome-headless-shell/chrome-headless-shell",
    archive: "zip",
    strip: 1,
    into: "chrome-headless-shell",
    targets: {
      "linux-x64": { url: chromeUrl("linux64"), sha256: "1b150320178ecabe39726bcf3198ebb896ba2b7a07d870db1710914c42d55221", sizeMB: 114 },
    },
  },
};

/** "<os>-<arch>" da máquina, no formato da tabela acima. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}
