// Página de conferência (`/bichos.html` no servidor de desenvolvimento): todas as poses e quadros de cada bicho,
// ampliados, sobre um fundo de dia e um de noite, e o espelho (olhando para a esquerda).
import { QUADROS_CALOPSITA, quadroCalopsita, type PoseCalopsita } from "./arteCalopsita";
import { QUADROS_GATO, quadroGato, type PoseGato } from "./arteGato";
import { QUADROS_CACHORRO, quadroCachorro, type PoseCachorro } from "./arteCachorro";
import { quadroCoracao, quadroNota, quadroPoleiro, quadroZ } from "./arteEfeitos";
import { paraCanvas } from "./desenho";
import type { Lado, Quadro } from "./arteComum";

interface Folha {
  titulo: string;
  poses: { nome: string; quadros: number; quadro: (i: number, lado: Lado) => Quadro }[];
}

const FOLHAS: Folha[] = [
  {
    titulo: "Calopsita",
    poses: (Object.keys(QUADROS_CALOPSITA) as PoseCalopsita[]).map((p) => ({ nome: p, quadros: QUADROS_CALOPSITA[p], quadro: (i, lado) => quadroCalopsita(p, i, lado) })),
  },
  {
    titulo: "Gato",
    poses: (Object.keys(QUADROS_GATO) as PoseGato[]).map((p) => ({ nome: p, quadros: QUADROS_GATO[p], quadro: (i, lado) => quadroGato(p, i, lado) })),
  },
  {
    titulo: "Cachorro",
    poses: (Object.keys(QUADROS_CACHORRO) as PoseCachorro[]).map((p) => ({ nome: p, quadros: QUADROS_CACHORRO[p], quadro: (i, lado) => quadroCachorro(p, i, lado) })),
  },
  {
    titulo: "Extras",
    poses: [
      { nome: "coracao", quadros: 1, quadro: () => quadroCoracao() },
      { nome: "nota", quadros: 2, quadro: (i) => quadroNota(i) },
      { nome: "z", quadros: 2, quadro: (i) => quadroZ(i) },
      { nome: "poleiro", quadros: 1, quadro: () => quadroPoleiro() },
    ],
  },
];

const params = new URLSearchParams(location.search);
const ZOOM = Number(params.get("zoom") ?? 10);
const SO = params.get("so");
const raiz = document.getElementById("raiz")!;

function celula(q: Quadro, rotulo: string, fundo: "dia" | "noite"): HTMLElement {
  const d = paraCanvas(q);
  const c = document.createElement("canvas");
  c.width = d.canvas.width * ZOOM;
  c.height = d.canvas.height * ZOOM;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(d.canvas, 0, 0, c.width, c.height);
  const box = document.createElement("div");
  box.className = `quadro ${fundo}`;
  box.append(c);
  const r = document.createElement("div");
  r.className = "rotulo";
  r.textContent = `${rotulo} ${d.canvas.width}x${d.canvas.height}`;
  box.append(r);
  return box;
}

for (const folha of FOLHAS) {
  if (SO && folha.titulo.toLowerCase() !== SO) continue;
  const h = document.createElement("h2");
  h.textContent = folha.titulo;
  raiz.append(h);
  for (const fundo of ["dia", "noite"] as const) {
    const linha = document.createElement("div");
    linha.className = "linha";
    for (const pose of folha.poses) for (let i = 0; i < pose.quadros; i++) linha.append(celula(pose.quadro(i, "right"), `${pose.nome} ${i}`, fundo));
    raiz.append(linha);
  }
  const esq = document.createElement("div");
  esq.className = "linha";
  for (const pose of folha.poses) esq.append(celula(pose.quadro(0, "left"), `${pose.nome} (esq)`, "dia"));
  raiz.append(esq);
}
