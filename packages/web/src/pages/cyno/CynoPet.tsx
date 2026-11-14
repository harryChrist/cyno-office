import type { CynoStatus } from "@cyno/shared";
import type { CSSProperties } from "react";
import { cynoPetPose } from "./petPose";
import "./cynoPet.css";

type Props = {
  status: CynoStatus | undefined;
  /** "md" = cabeça pequena (cabeçalho); "lg" = corpo inteiro (estado vazio). */
  size?: "md" | "lg";
  /** Há algo esperando o dono: o bichinho inclina a cabeça. */
  waiting?: boolean;
  /** Tamanho em pixels (substitui o de `size`; usado na folha de poses). */
  px?: number;
  /** Força só a cabeça ou o corpo inteiro (por padrão, a cabeça no "md" e o corpo no "lg"). */
  view?: "head" | "full";
  /** Texto para leitores de tela; sem ele o desenho é decorativo (aria-hidden). */
  label?: string;
};

/**
 * O bichinho do Cyno: um filhote de cão-raposa âmbar, de cabeça grande e rabo felpudo. O estado vem do
 * `status` do Cyno (dormindo, acordando, trabalhando, acordado); só `transform` e `opacity` se mexem.
 */
export function CynoPet({ status, size = "md", waiting = false, px, view, label }: Props) {
  const pose = cynoPetPose(status, waiting);
  const full = (view ?? (size === "lg" ? "full" : "head")) === "full";
  const style = px ? ({ width: px, height: px } as CSSProperties) : undefined;
  return (
    <span className={`cyno-pet cyno-pet--${size}${full ? " cyno-pet--full" : ""}`} data-status={status ?? "sleeping"} data-pose={pose.name} style={style} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      <svg viewBox={full ? "0 0 120 124" : "17 12 86 87"} focusable="false">
        {full && (
          <>
            <g className="cp-tail">
              <path className="cp-fur" d="M80 112C98 112 110 98 106 78C104 70 98 66 96 70C98 84 92 96 78 98Z" />
              <path className="cp-cream" d="M106 78C104 70 98 66 96 70C95 75 97 80 98 84C103 85 106 82 106 78Z" />
            </g>
            <g className="cp-body">
              <path className="cp-fur" d="M42 84C32 96 32 114 42 118H78C88 114 88 96 78 84Z" />
              <path className="cp-cream" d="M60 90C52 90 49 100 51 108C52 114 56 116 60 116C64 116 68 114 69 108C71 100 68 90 60 90Z" />
              <ellipse className="cp-cream" cx="48" cy="117.5" rx="7" ry="4" />
              <ellipse className="cp-cream" cx="72" cy="117.5" rx="7" ry="4" />
            </g>
          </>
        )}
        <g className="cp-head">
          <g className="cp-ear cp-ear--l">
            <path className="cp-fur" d="M29 52C25 38 26 27 30 21C32 18 35 19 37 20C44 24 51 30 55 37Z" />
            <path className="cp-inner" d="M33 43C31 36 32 30 34 27C38 29 42 33 46 37Z" />
          </g>
          <g className="cp-ear cp-ear--r">
            <path className="cp-fur" d="M91 52C97 44 102 36 101 31C100 27 96 26 93 28C84 31 72 34 65 38Z" />
            <path className="cp-inner" d="M88 44C91 40 94 36 94 34C90 35 83 37 76 40Z" />
          </g>
          <path className="cp-fur" d="M60 30C80 30 94 42 94 58C94 74 80 86 60 86C40 86 26 74 26 58C26 42 40 30 60 30Z" />
          <path className="cp-cream" d="M60 60C72 60 80 68 78 76C76 83 68 86 60 86C52 86 44 83 42 76C40 68 48 60 60 60Z" />
          <ellipse className="cp-nose" cx="60" cy="66.5" rx="4.2" ry="3" />
          <g className="cp-eyes">
            <ellipse className="cp-eye" cx="46" cy="56" rx="4" ry="5.2" />
            <ellipse className="cp-eye" cx="74" cy="56" rx="4" ry="5.2" />
            <circle className="cp-glint" cx="47.4" cy="54" r="1.4" />
            <circle className="cp-glint" cx="75.4" cy="54" r="1.4" />
          </g>
          <g className="cp-eyes-closed">
            <path className="cp-lid" d="M41 57Q46 61 51 57" />
            <path className="cp-lid" d="M69 57Q74 61 79 57" />
          </g>
          <path className="cp-collar" d="M38 84Q60 94 82 84" />
          <circle className="cp-tag" cx="60" cy="92" r="3.4" />
        </g>
        {pose.zzz && full && (
          <g className="cp-zzz">
            <text className="cp-z cp-z--1" x="100" y="18">
              z
            </text>
            <text className="cp-z cp-z--2" x="108" y="8">
              z
            </text>
          </g>
        )}
        {pose.zzz && !full && (
          <g className="cp-zzz">
            <text className="cp-z cp-z--1" x="97" y="22">
              z
            </text>
          </g>
        )}
      </svg>
    </span>
  );
}
