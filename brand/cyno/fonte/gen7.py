#!/usr/bin/env python3
"""Cyno — final kit for concept A "Sala C". Usage: python3 gen7.py <outdir>

Construction (256 grid, 2:1 pixel isometric):
  * outer hexagon = silhouette of an isometric cube, half-width W=100, vertical edge H=100 (square footprint)
  * walls 34 units thick (perpendicular), C opening cut vertically at cx+44
  * back walls show their inner face (height 20) in a lighter tone = the room has depth
  * the agent: a 2:1 isometric cube (half-width 36, height 36) standing in the room, three greens
"""
import math
import sys
OUTDIR = sys.argv[1]
sys.argv = [sys.argv[0], OUTDIR]
import gen  # noqa: E402
from gen import *  # noqa: E402,F401,F403

gen.OUT = OUTDIR
os.makedirs(OUTDIR, exist_ok=True)

INK_T = "#14162B"
TEXT_DARK = "#E8EAF6"   # --ui-text

PAL_LIGHT = dict(wall=VIOLET, face_l="#AB9FFF", face_r="#8B7CFF", top=GREEN, left=GREEN_M, right=GREEN_D)
PAL_DARK = dict(wall=VIOLET_L, face_l="#D6D0FF", face_r="#B4A9FF", top=GREEN, left=GREEN_M, right=GREEN_D)
PAL_TILE = dict(wall=WHITE, face_l="#D6D0FF", face_r="#B4A9FF", top=GREEN, left=GREEN_M, right=GREEN_D)

W, H, WALL, CUT, DX = 100, 100, 34, 44, 20
CX = 128 + DX
TOP = 128 - (W + H) / 2


def geometry():
    cx = CX
    outer = [(cx, TOP), (cx + W, TOP + W / 2), (cx + W, TOP + W / 2 + H), (cx, TOP + W + H),
             (cx - W, TOP + W / 2 + H), (cx - W, TOP + W / 2)]
    inner = offset_poly(outer, WALL)
    cut = cx + CUT

    def y_at(poly, x, upper):
        ys = []
        for i in range(len(poly)):
            p, q = poly[i], poly[(i + 1) % len(poly)]
            if (p[0] - x) * (q[0] - x) <= 0 and p[0] != q[0]:
                s = (x - p[0]) / (q[0] - p[0])
                ys.append(p[1] + (q[1] - p[1]) * s)
        return min(ys) if upper else max(ys)

    T, UR, LR, B, LL, UL = outer
    Ti, URi, LRi, Bi, LLi, ULi = inner
    ou, ol, iu, il = y_at(outer, cut, 1), y_at(outer, cut, 0), y_at(inner, cut, 1), y_at(inner, cut, 0)
    c_pts = [(cut, ou), T, UL, LL, B, (cut, ol), (cut, il), Bi, LLi, ULi, Ti, (cut, iu)]
    hw = 20
    face_l = [ULi, Ti, (Ti[0], Ti[1] + hw), (ULi[0], ULi[1] + hw)]
    face_r = [Ti, (cut, iu), (cut, iu + hw), (Ti[0], Ti[1] + hw)]
    # agent cube, centred in the room's free floor (between inner left wall and the cut), sitting low
    a, h = 32, 32
    ccx = (ULi[0] + cut) / 2 - 2
    ctop = 128 - (a + h) / 2 + 14
    tf, lf, rf = iso_cube(ccx, ctop, a, h)
    return dict(c=c_pts, face_l=face_l, face_r=face_r, top=tf, left=lf, right=rf)


def r2(pts):
    return [(round(x, 2), round(y, 2)) for x, y in pts]


def mark_body(pal, depth=True):
    g = geometry()
    b = f'<path fill="{pal["wall"]}" d="{poly_d(g["c"])}"/>'
    if depth:
        b += f'<path fill="{pal["face_l"]}" d="{poly_d(g["face_l"])}"/><path fill="{pal["face_r"]}" d="{poly_d(g["face_r"])}"/>'
    b += (f'<path fill="{pal["top"]}" d="{poly_d(g["top"])}"/><path fill="{pal["left"]}" d="{poly_d(g["left"])}"/>'
          f'<path fill="{pal["right"]}" d="{poly_d(g["right"])}"/>')
    return b


def shrink(poly, d):
    """Uniform inward offset for convex polygons of either orientation."""
    if area(poly) < 0:  # offset_poly expects clockwise-on-screen (positive area in y-down)
        return offset_poly(poly[::-1], d)
    return offset_poly(poly, d)


def mark_mono_body(color="currentColor"):
    g = geometry()
    gap = 3.5  # half of the 7-unit knock-out between cube faces
    faces = "".join(poly_d(shrink(p, gap)) for p in (g["top"], g["left"], g["right"]))
    return f'<path fill="{color}" d="{poly_d(g["c"])}{faces}"/>'


def mark(pal=PAL_LIGHT, title="Cyno — símbolo"):
    return svg("0 0 256 256", mark_body(pal), title)


def tile_body(scale=0.82, square=False):
    rx = 0 if square else 56
    return (f'<rect width="256" height="256" rx="{rx}" fill="{VIOLET}"/>'
            f'<g transform="translate(128 128) scale({scale}) translate(-128 -128)">{mark_body(PAL_TILE)}</g>')


# ----------------------------------------------------------------------------- pixel cuts (16 px)
def runs(rows_map, ox, oy):
    """rows_map: {row: [(c0, c1, colour), ...]} -> rect elements (1 unit = 1 px)."""
    out = []
    for r, spans in rows_map.items():
        for c0, c1, col in spans:
            out.append(f'<rect x="{c0 + ox}" y="{r + oy}" width="{c1 - c0 + 1}" height="1" fill="{col}"/>')
    return "".join(out)


def pixel_symbol(outer, inner, cut, cube, wall_col, ox, oy):
    """Build per-row spans: wall = outer minus inner, minus cols >= cut; cube spans drawn on top."""
    rows = {}
    for r, (o0, o1) in outer.items():
        cols = set(range(o0, o1 + 1))
        if r in inner:
            i0, i1 = inner[r]
            cols -= set(range(i0, i1 + 1))
        cols = sorted(c for c in cols if c < cut)
        spans, start, prev = [], None, None
        for c in cols:
            if start is None:
                start = prev = c
            elif c == prev + 1:
                prev = c
            else:
                spans.append((start, prev, wall_col))
                start = prev = c
        if start is not None:
            spans.append((start, prev, wall_col))
        rows[r] = spans
    for r, spans in cube.items():
        rows.setdefault(r, [])
        rows[r] = rows[r] + spans
    return runs(rows, ox, oy)


T_, L_, R_ = GREEN, GREEN_M, GREEN_D

# 16-grid symbol (transparent background)
OUT16 = {0: (6, 9), 1: (4, 11), 2: (2, 13), **{r: (0, 15) for r in range(3, 13)}, 13: (2, 13), 14: (4, 11), 15: (6, 9)}
IN16 = {3: (6, 9), 4: (4, 11), **{r: (3, 12) for r in range(5, 11)}, 11: (4, 11), 12: (6, 9)}
CUBE16 = {6: [(5, 8, T_)], 7: [(5, 8, T_)], 8: [(5, 6, L_), (7, 8, R_)], 9: [(5, 6, L_), (7, 8, R_)]}

# 12-grid symbol (inside the 16 px tile)
OUT12 = {0: (4, 7), 1: (2, 9), **{r: (0, 11) for r in range(2, 10)}, 10: (2, 9), 11: (4, 7)}
IN12 = {2: (4, 7), **{r: (2, 9) for r in range(3, 9)}, 9: (4, 7)}
CUBE12 = {4: [(3, 6, T_)], 5: [(3, 4, L_), (5, 6, R_)], 6: [(3, 4, L_), (5, 6, R_)]}


def small_symbol(wall=VIOLET):
    body = pixel_symbol(OUT16, IN16, 12, CUBE16, wall, 2, 0)
    return svg("0 0 16 16", f'<g shape-rendering="crispEdges">{body}</g>', "Cyno — símbolo, corte pequeno (16–24 px)")


def small_tile():
    bg = VIOLET
    # 16 px rounded square: two pixels cut at each corner
    rows = {0: (2, 13), 1: (1, 14), **{r: (0, 15) for r in range(2, 14)}, 14: (1, 14), 15: (2, 13)}
    tile = "".join(f'<rect x="{a}" y="{r}" width="{b - a + 1}" height="1" fill="{bg}"/>' for r, (a, b) in rows.items())
    sym = pixel_symbol(OUT12, IN12, 9, CUBE12, WHITE, 4, 2)
    return svg("0 0 16 16", f'<g shape-rendering="crispEdges">{tile}{sym}</g>', "Cyno — ícone 16 px")


# ----------------------------------------------------------------------------- lockup "Cyno"
def wordmark_cyno(fill, x0, base):
    tp = Type()
    cap = Type(xh=150, t=28, rc=40)
    paths = []
    cp, cw = cap.c(x0, base, 132)
    paths += cp
    x = x0 + cw + 18
    for ch, gap in (("y", 26), ("n", 26), ("o", 0)):
        p, w = {"y": tp.y, "n": tp.n, "o": tp.o}[ch](x, base)
        paths += p
        x += w + gap
    return f'<path fill="{fill}" d="{"".join(paths)}"/>', x


def lockup_final(dark=False):
    pal = PAL_DARK if dark else PAL_LIGHT
    sym = mark_body(pal)
    word, end = wordmark_cyno(TEXT_DARK if dark else INK_T, 248, 196)
    w = int(math.ceil(end + 20))
    title = "Cyno — assinatura, fundo escuro" if dark else "Cyno — assinatura, fundo claro"
    return svg(f"32 0 {w - 32} 256", sym + word, title)


if __name__ == "__main__":
    write("cyno-mark.svg", mark())
    write("cyno-mark-escuro.svg", mark(PAL_DARK, "Cyno — símbolo, fundo escuro"))
    write("cyno-mark-mono.svg", svg("0 0 256 256", mark_mono_body(), "Cyno — símbolo, uma cor"))
    write("cyno-mark-small.svg", small_symbol())
    write("cyno-lockup.svg", lockup_final(dark=True))
    write("cyno-lockup-claro.svg", lockup_final(dark=False))
    write("cyno-tile.svg", svg("0 0 256 256", tile_body(), "Cyno — ícone do app"))
    write("cyno-tile-square.svg", svg("0 0 256 256", tile_body(square=True), "Cyno — ícone do app, quadrado"))
    write("cyno-tile-small.svg", small_tile())
