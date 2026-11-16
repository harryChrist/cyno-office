import type { Avatar } from "@cyno/shared";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useArteDoMotor } from "../cena/arteDoMotor";
import { avatarParaPartes, hash32, parecenca, partesDoMaestro } from "@cyno/shared/cena";
import type { AvatarDirection } from "./avatarDirections";
import { BUSTO, medirCabeca, QUADRO_ALTURA, QUADRO_LARGURA, ROSTO } from "./avatarMedida";

/** Recorte: corpo inteiro ou só a cabeça e os ombros (para listas e bolinhas). */
export type AvatarFraming = "full" | "head";

const DIRECAO = { SE: "down", SW: "left", NE: "right", NW: "up" } as const;

/** Densidade de pixels do aparelho (acompanha o zoom e a troca de tela). */
function useDensidade(): number {
  return useSyncExternalStore(
    (aviso) => {
      window.addEventListener("resize", aviso);
      return () => window.removeEventListener("resize", aviso);
    },
    () => window.devicePixelRatio || 1,
    () => 1,
  );
}

type AvatarSpriteProps = {
  avatar: Avatar;
  /** Fator inteiro de ampliação (pixel art nítida). Com `framing="head"`, `size` tem preferência. */
  scale?: number;
  /** Cabeça: tamanho em pixels de tela da caixa onde o rosto vai (ex.: 24, 36). O componente escolhe a ampliação inteira que cabe e o recorte. */
  size?: number;
  direction?: AvatarDirection;
  framing?: AvatarFraming;
  /** Mantido por compatibilidade: o personagem do motor fica parado nos painéis. */
  animate?: boolean;
  /** Id do agente: dá ao boneco a mesma semente (olhos, sapatos...) que ele tem na cena. Sem id, a semente vem do avatar. */
  seedId?: string;
  /** O Maestro tem visual fixo (camisa social e fone) também na cena. */
  maestro?: boolean;
  className?: string;
  testId?: string;
};

/**
 * O personagem da cena (motor do Habblaud) desenhado num <canvas> ampliado sem suavização, para o agente ter uma
 * cara só: a mesma aparência (peças do avatar do Cyno + sorteio pela semente) que a cena usa. Carrega a arte do
 * motor na primeira vez; até lá o espaço fica reservado.
 */
export function AvatarSprite({ avatar, scale = 1, size, direction = "SE", framing = "full", seedId, maestro = false, className, testId }: AvatarSpriteProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const arte = useArteDoMotor();
  const dpr = useDensidade();
  const cabeca = framing === "head";
  const fator = Math.max(1, Math.round(scale));
  // Cabeça: recorte e ampliação saem da caixa pedida (ou, sem `size`, do fator antigo sobre o busto de 20 px).
  const medida = cabeca ? medirCabeca(size ?? BUSTO * fator, dpr) : null;
  const largura = medida ? medida.recorte : QUADRO_LARGURA;
  const altura = medida ? medida.recorte : QUADRO_ALTURA;
  const ampliacao = medida ? medida.ampliacao : 1;
  const pixelsLargura = largura * ampliacao;
  const pixelsAltura = altura * ampliacao;
  // O corpo inteiro segue o fator inteiro de CSS; a cabeça ocupa exatamente os pixels do aparelho que desenha.
  const cssLargura = medida ? medida.cssPx : largura * fator;
  const cssAltura = medida ? medida.cssPx : altura * fator;
  // Recorte dentro do quadro do motor: o busto começa em (2,2); o rosto, em (3,3).
  const origem = medida ? (medida.recorte === ROSTO ? 3 : 2) : 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !arte) return;
    const semente = hash32(seedId ?? JSON.stringify(avatar));
    const aparencia = arte.appearanceFromSeed(semente, { look: parecenca(avatar, semente & 1), parts: maestro ? partesDoMaestro(avatar) : avatarParaPartes(avatar) });
    const sprite = arte.characterSprite({ appearance: aparencia, dir: DIRECAO[direction], pose: "stand", frame: 0 });
    canvas.width = pixelsLargura;
    canvas.height = pixelsAltura;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, pixelsLargura, pixelsAltura);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite.canvas, origem, origem, largura, altura, 0, 0, pixelsLargura, pixelsAltura);
  }, [avatar, direction, maestro, arte, seedId, largura, altura, pixelsLargura, pixelsAltura, origem]);

  return (
    <canvas
      ref={ref}
      width={pixelsLargura}
      height={pixelsAltura}
      className={`pixel-sprite${className ? ` ${className}` : ""}`}
      style={{ width: cssLargura, height: cssAltura }}
      aria-hidden="true"
      data-testid={testId}
      data-framing={framing}
      data-recorte={medida ? `${medida.recorte}x${ampliacao}` : undefined}
      data-avatar={[avatar.skin, avatar.hair, avatar.hairColor, avatar.shirt, avatar.pants, avatar.accessory ?? "-"].join("|")}
      data-motor="cena"
    />
  );
}
