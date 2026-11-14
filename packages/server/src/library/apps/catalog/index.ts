import { catalogSchema, type CatalogApp } from "@cyno/shared";
import { comingSoon } from "./coming-soon";
import { ffmpegSkill } from "./ffmpeg-skill";
import { hyperframes } from "./hyperframes";
import { laya } from "./laya";
import { remotion } from "./remotion";
import { markitdown } from "./markitdown";

/**
 * O catálogo curado de apps (mantido por nós, versões fixadas). Validado na carga: uma entrada
 * inválida derruba o boot em vez de aparecer pela metade na tela. Atualizar um app = mudar a versão
 * fixada e o `recipeVersion` aqui.
 */
export const APP_CATALOG: CatalogApp[] = catalogSchema.parse([markitdown, laya, hyperframes, ffmpegSkill, remotion, ...comingSoon]);
