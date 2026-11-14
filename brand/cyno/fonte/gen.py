#!/usr/bin/env python3
"""Generate the Cyno logo concepts as clean SVG (paths only, no <text>)."""
import math
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)

VIOLET = "#6D5CF5"
VIOLET_L = "#8B7CFF"
GREEN = "#3DDC97"
GREEN_M = "#2FBF80"
GREEN_D = "#1F9E68"
INK = "#0B0D1A"
WHITE = "#FFFFFF"


def f(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# ----------------------------------------------------------------------------- stroked polylines -> outlines
def _norm(v):
    l = math.hypot(*v)
    return (v[0] / l, v[1] / l)


def stroke_outline(pts, t, radii, closed=False):
    """Outline of an orthogonal (or any) polyline stroked with width t and rounded centreline corners.

    radii[i] = centreline corner radius at vertex i (ignored at open ends). Returns list of contours, each a list
    of segments ("M"/"L"/"A") as SVG path strings with consistent positive orientation handled later.
    """
    d = t / 2.0
    n = len(pts)

    def corner(i, side):
        """Return (start_point, end_point, radius, sweep) of the offset arc at vertex i on side (+1 left / -1 right)."""
        p_prev, p, p_next = pts[i - 1], pts[i], pts[(i + 1) % n]
        u = _norm((p[0] - p_prev[0], p[1] - p_prev[1]))
        v = _norm((p_next[0] - p[0], p_next[1] - p[1]))
        rc = radii[i]
        # left normal in SVG coords (y down): rotate dir by -90deg => (u.y, -u.x)
        nu = (u[1], -u[0])
        nv = (v[1], -v[0])
        cross = u[0] * v[1] - u[1] * v[0]  # >0 : clockwise turn on screen
        if rc <= 0:
            # miter join
            a = (p[0] + nu[0] * d * side, p[1] + nu[1] * d * side)
            b = (p[0] + nv[0] * d * side, p[1] + nv[1] * d * side)
            # intersect line a + s*u with b + r*v
            den = u[0] * v[1] - u[1] * v[0]
            s = ((b[0] - a[0]) * v[1] - (b[1] - a[1]) * v[0]) / den
            m = (a[0] + u[0] * s, a[1] + u[1] * s)
            return m, m, 0, 0
        cs = (p[0] - u[0] * rc, p[1] - u[1] * rc)
        ce = (p[0] + v[0] * rc, p[1] + v[1] * rc)
        a = (cs[0] + nu[0] * d * side, cs[1] + nu[1] * d * side)
        b = (ce[0] + nv[0] * d * side, ce[1] + nv[1] * d * side)
        # inner side of a clockwise turn is the right side (side=-1)
        inner = (cross > 0 and side == -1) or (cross < 0 and side == 1)
        r = rc - d if inner else rc + d
        sweep = 1 if cross > 0 else 0
        return a, b, r, sweep

    def side_path(side, idxs):
        segs = []
        for i in idxs:
            a, b, r, sw = corner(i, side)
            segs.append(("L", a))
            if r > 0.01 and (a != b):
                segs.append(("A", b, r, sw))
        return segs

    if closed:
        contours = []
        for side in (1, -1):
            segs = side_path(side, range(n))
            contours.append(segs)
        return contours
    # open polyline
    u0 = _norm((pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]))
    n0 = (u0[1], -u0[0])
    un = _norm((pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]))
    nn = (un[1], -un[0])
    segs = [("L", (pts[0][0] + n0[0] * d, pts[0][1] + n0[1] * d))]
    segs += side_path(1, range(1, n - 1))
    segs.append(("L", (pts[-1][0] + nn[0] * d, pts[-1][1] + nn[1] * d)))
    segs.append(("L", (pts[-1][0] - nn[0] * d, pts[-1][1] - nn[1] * d)))
    # right side walked backwards: reverse each arc
    right = side_path(-1, range(1, n - 1))
    back = []
    # convert forward right-side list to reversed traversal
    pts_seq = []
    for s in right:
        pts_seq.append(s)
    for s in reversed(pts_seq):
        if s[0] == "A":
            back.append(("REV_A", s))
        else:
            back.append(s)
    # rebuild: forward right side is L a, A b ... ; reversed: L b, A a (flipped sweep)
    rev = []
    i = len(right) - 1
    while i >= 0:
        s = right[i]
        if s[0] == "A":
            start = right[i - 1][1]
            rev.append(("L", s[1]))
            rev.append(("A", start, s[2], 1 - s[3]))
            i -= 2
        else:
            rev.append(("L", s[1]))
            i -= 1
    segs += rev
    segs.append(("L", (pts[0][0] - n0[0] * d, pts[0][1] - n0[1] * d)))
    return [segs]


def sample(segs):
    """Approximate a contour by points (for orientation)."""
    out = []
    cur = None
    for s in segs:
        if s[0] == "L":
            out.append(s[1])
            cur = s[1]
        else:
            out.append(s[1])
            cur = s[1]
    return out


def area(pts):
    a = 0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2


def reverse(segs):
    """Reverse a closed contour made of L/A segments (first seg is L = start point)."""
    pts = []  # list of (point, how_we_arrived)
    for s in segs:
        pts.append(s)
    out = []
    # traversal points
    nodes = [s[1] for s in segs]
    kinds = segs
    m = len(segs)
    # segment k goes from nodes[k-1] to nodes[k] (with nodes[-1] wrap for k=0 -> start is closure)
    out.append(("L", nodes[-1]))
    for k in range(m - 1, 0, -1):
        s = kinds[k]
        if s[0] == "A":
            out.append(("A", nodes[k - 1], s[2], 1 - s[3]))
        else:
            out.append(("L", nodes[k - 1]))
    return out


def to_d(contour):
    parts = []
    for i, s in enumerate(contour):
        if i == 0:
            parts.append(f"M{f(s[1][0])} {f(s[1][1])}")
        elif s[0] == "L":
            parts.append(f"L{f(s[1][0])} {f(s[1][1])}")
        else:
            parts.append(f"A{f(s[2])} {f(s[2])} 0 0 {s[3]} {f(s[1][0])} {f(s[1][1])}")
    parts.append("Z")
    return "".join(parts)


def orient(contour, positive=True):
    a = area(sample(contour))
    if (a > 0) != positive:
        return reverse(contour)
    return contour


def poly_d(pts):
    return "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"


def rrect_d(x, y, w, h, r, positive=True):
    """Rounded rectangle as path (clockwise on screen = positive area in y-down coords)."""
    c = [
        ("L", (x + r, y)), ("L", (x + w - r, y)), ("A", (x + w, y + r), r, 1),
        ("L", (x + w, y + h - r)), ("A", (x + w - r, y + h), r, 1),
        ("L", (x + r, y + h)), ("A", (x, y + h - r), r, 1),
        ("L", (x, y + r)), ("A", (x + r, y), r, 1),
    ]
    if r <= 0:
        c = [("L", (x, y)), ("L", (x + w, y)), ("L", (x + w, y + h)), ("L", (x, y + h))]
    return to_d(orient(c, positive))


# ----------------------------------------------------------------------------- the wordmark ("cyno", "office")
class Type:
    def __init__(self, xh=112, t=28, rc=30, desc=44, asc=156):
        self.xh, self.t, self.rc, self.desc, self.asc = xh, t, rc, desc, asc

    # every glyph returns (list_of_path_d_strings, advance_width)
    def bowl(self, x0, base, w, closed=True):
        t, rc = self.t, self.rc
        l, r = x0 + t / 2, x0 + w - t / 2
        top, bot = base - self.xh + t / 2, base - t / 2
        if closed:
            pts = [(l, top), (r, top), (r, bot), (l, bot)]
            cs = stroke_outline(pts, t, [rc] * 4, closed=True)
            # outer = bigger area
            cs.sort(key=lambda c: -abs(area(sample(c))))
            return [to_d(orient(cs[0], True)), to_d(orient(cs[1], False))]
        # c: open on the right
        pts = [(r, top + rc + 0.01), (r, top), (l, top), (l, bot), (r, bot), (r, bot - rc - 0.01)]
        cs = stroke_outline(pts, t, [0, rc, rc, rc, rc, 0])
        return [to_d(orient(cs[0], True))]

    def c(self, x0, base, w=112):
        return self.bowl(x0, base, w, closed=False), w

    def o(self, x0, base, w=116):
        return self.bowl(x0, base, w, closed=True), w

    def n(self, x0, base, w=108):
        t, rc = self.t, self.rc
        l, r = x0 + t / 2, x0 + w - t / 2
        top = base - self.xh + t / 2
        pts = [(l, base), (l, top), (r, top), (r, base)]
        cs = stroke_outline(pts, t, [0, rc, rc, 0])
        return [to_d(orient(cs[0], True))], w

    def y(self, x0, base, w=108):
        t, rc = self.t, self.rc
        l, r = x0 + t / 2, x0 + w - t / 2
        top, bot = base - self.xh, base - t / 2
        u = [(l, top), (l, bot), (r, bot)]
        stem_bot = base + self.desc - t / 2
        stem = [(r, top), (r, stem_bot), (x0 + 10, stem_bot)]
        a = stroke_outline(u, t, [0, rc, 0])[0]
        b = stroke_outline(stem, t, [0, rc, 0])[0]
        return [to_d(orient(a, True)), to_d(orient(b, True))], w

    def i(self, x0, base, w=28):
        t = self.t
        stem = rrect_d(x0, base - self.xh, t, self.xh, 0)
        dot = rrect_d(x0, base - self.xh - 16 - t, t, t, 0)
        return [stem, dot], w

    def f_(self, x0, base, w=76):
        t, rc = self.t, self.rc
        l = x0 + t / 2
        top = base - self.asc + t / 2
        pts = [(x0 + w, top), (l, top), (l, base)]
        a = stroke_outline(pts, t, [0, rc, 0])[0]
        bar = rrect_d(x0, base - self.xh, w - 8, t * 0.9, 0)
        return [to_d(orient(a, True)), bar], w

    def e(self, x0, base, w=112):
        t, rc = self.t, self.rc
        l, r = x0 + t / 2, x0 + w - t / 2
        top, bot = base - self.xh + t / 2, base - t / 2
        mid = base - self.xh / 2 - 2
        pts = [(r, mid), (r, top), (l, top), (l, bot), (r, bot)]
        a = stroke_outline(pts, t, [0, rc, rc, rc, 0])[0]
        bar = rrect_d(x0 + t / 2, mid - t * 0.45, w - t, t * 0.9, 0)
        return [to_d(orient(a, True)), bar], w

    def word(self, text, x0, base, gaps):
        paths, x = [], x0
        for k, ch in enumerate(text):
            fn = {"c": self.c, "o": self.o, "n": self.n, "y": self.y, "i": self.i, "f": self.f_, "e": self.e}[ch]
            p, w = fn(x, base)
            paths += p
            x += w + (gaps[k] if k < len(gaps) else 0)
        return paths, x - x0


def svg(viewbox, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" role="img" aria-labelledby="title">'
            f'<title id="title">{title}</title>{body}</svg>\n')


def write(name, content):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(content)
    print("wrote", name)


# ----------------------------------------------------------------------------- concept A: "Sala C"
def iso_cube(cx, top, a, h):
    """2:1 isometric cube: top rhombus half-width a, vertical edge h. Returns (top, left, right) polygons."""
    T = (cx, top)
    R = (cx + a, top + a / 2)
    F = (cx, top + a)
    L = (cx - a, top + a / 2)
    topf = [T, R, F, L]
    left = [L, F, (F[0], F[1] + h), (L[0], L[1] + h)]
    right = [F, R, (R[0], R[1] + h), (F[0], F[1] + h)]
    return topf, left, right


def offset_poly(pts, d):
    """Inward offset of a convex clockwise (screen) polygon by perpendicular distance d."""
    n = len(pts)
    lines = []
    for i in range(n):
        p, q = pts[i], pts[(i + 1) % n]
        u = _norm((q[0] - p[0], q[1] - p[1]))
        # inward normal for clockwise-on-screen polygon: rotate +90 in y-down => (-u.y, u.x)
        nrm = (-u[1], u[0])
        lines.append(((p[0] + nrm[0] * d, p[1] + nrm[1] * d), u))
    out = []
    for i in range(n):
        (a, u), (b, v) = lines[i - 1], lines[i]
        den = u[0] * v[1] - u[1] * v[0]
        s = ((b[0] - a[0]) * v[1] - (b[1] - a[1]) * v[0]) / den
        out.append((a[0] + u[0] * s, a[1] + u[1] * s))
    return out


def concept_a(variant="color"):
    W, H = 100, 108
    top = 128 - (W + H) / 2 - 2  # optical lift
    cx = 128
    outer = [(cx, top), (cx + W, top + W / 2), (cx + W, top + W / 2 + H), (cx, top + W + H),
             (cx - W, top + W / 2 + H), (cx - W, top + W / 2)]
    wall = 34
    inner = offset_poly(outer, wall)
    # C opening: cut everything right of x = cut, between the two slanted arms
    cut = cx + 44

    def clip_x(poly, xmax):
        out = []
        n = len(poly)
        for i in range(n):
            p, q = poly[i], poly[(i + 1) % n]
            pin, qin = p[0] <= xmax, q[0] <= xmax
            if pin:
                out.append(p)
            if pin != qin:
                s = (xmax - p[0]) / (q[0] - p[0])
                out.append((xmax, p[1] + (q[1] - p[1]) * s))
        return out

    o_c = clip_x(outer, cut)
    i_c = clip_x(inner, cut)
    # ring with opening = outer clipped minus inner clipped, written as one evenodd path
    # build the C directly: walk outer clipped (clockwise), then the inner clipped reversed, joined at the cut
    # outer clipped starts at top vertex ... we construct explicit C contour
    # upper arm: outer from cut-point on upper-right edge, around left, to cut-point on lower-right edge
    def edge_y_at(poly, x, upper=True):
        ys = []
        n = len(poly)
        for i in range(n):
            p, q = poly[i], poly[(i + 1) % n]
            if (p[0] - x) * (q[0] - x) <= 0 and p[0] != q[0]:
                s = (x - p[0]) / (q[0] - p[0])
                ys.append(p[1] + (q[1] - p[1]) * s)
        return min(ys) if upper else max(ys)

    ou, ol = edge_y_at(outer, cut, True), edge_y_at(outer, cut, False)
    iu, il = edge_y_at(inner, cut, True), edge_y_at(inner, cut, False)
    # outer: (cut,ou) -> T -> UL -> LL -> B -> (cut,ol)
    T, UR, LR, B, LL, UL = outer
    Ti, URi, LRi, Bi, LLi, ULi = inner
    c_pts = [(cut, ou), T, UL, LL, B, (cut, ol), (cut, il), Bi, LLi, ULi, Ti, (cut, iu)]
    c_d = poly_d(c_pts)

    ca = 30
    ch = 34
    ccx = cx - 4
    ctop = 128 - (ca + ch) / 2 + 2
    tf, lf, rf = iso_cube(ccx, ctop, ca, ch)
    if variant == "color":
        wall_fill = VIOLET
        body = (f'<path fill="{wall_fill}" d="{c_d}"/>'
                f'<path fill="{GREEN}" d="{poly_d(tf)}"/><path fill="{GREEN_M}" d="{poly_d(lf)}"/>'
                f'<path fill="{GREEN_D}" d="{poly_d(rf)}"/>')
    elif variant == "tile":
        body = (f'<rect width="256" height="256" rx="56" fill="{VIOLET}"/>'
                f'<g transform="translate(128 128) scale(0.74) translate(-128 -128)">'
                f'<path fill="{WHITE}" d="{c_d}"/>'
                f'<path fill="{GREEN}" d="{poly_d(tf)}"/><path fill="{GREEN_M}" d="{poly_d(lf)}"/>'
                f'<path fill="{GREEN_D}" d="{poly_d(rf)}"/></g>')
    else:  # one colour: cube faces separated by knock-out gaps (real holes)
        gap = 5
        sil = [tf[0], tf[1], rf[2], rf[3], lf[3], tf[3]]
        # split lines: F->T? cube shows Y: from F up? we cut a Y of gaps: F to L, F to R, F down
        body = f'<path fill="#000000" d="{c_d}"/>'
        # draw faces slightly inset to leave hairline-free gaps
        def inset(poly, k):
            cxp = sum(p[0] for p in poly) / len(poly)
            cyp = sum(p[1] for p in poly) / len(poly)
            return [(cxp + (p[0] - cxp) * k, cyp + (p[1] - cyp) * k) for p in poly]
        body += f'<path fill="#000000" d="{poly_d(tf)}{poly_d(inset(lf, 0.82))}{poly_d(inset(rf, 0.82))}"/>'
    return svg("0 0 256 256", body, "Cyno — Sala C")


# ----------------------------------------------------------------------------- concept B: "Equipe em C"
def concept_b(variant="color", centre="diamond"):
    s, g, r = 60, 12, 12
    x0 = (256 - (3 * s + 2 * g)) / 2
    y0 = x0 - 2
    cells = [(0, 0), (1, 0), (2, 0), (0, 1), (0, 2), (1, 2), (2, 2)]
    team = "".join(rrect_d(x0 + i * (s + g), y0 + j * (s + g), s, s, r) for i, j in cells)
    cx = x0 + 1 * (s + g) + s / 2
    cy = y0 + 1 * (s + g) + s / 2
    if centre == "diamond":
        k = 34  # half-diagonal
        star = poly_d([(cx, cy - k), (cx + k, cy), (cx, cy + k), (cx - k, cy)])
    else:
        q = 40
        star = rrect_d(cx - q / 2, cy - q / 2, q, q, 8)
    if variant == "color":
        body = f'<path fill="{VIOLET}" d="{team}"/><path fill="{GREEN}" d="{star}"/>'
    elif variant == "tile":
        body = (f'<rect width="256" height="256" rx="56" fill="{VIOLET}"/>'
                f'<g transform="translate(128 128) scale(0.7) translate(-128 -128)">'
                f'<path fill="{WHITE}" d="{team}"/><path fill="{GREEN}" d="{star}"/></g>')
    else:
        body = f'<path fill="#000000" d="{team}{star}"/>'
    return svg("0 0 256 256", body, "Cyno — Equipe em C")


# ----------------------------------------------------------------------------- concept C: wordmark "cyno"
def concept_c_symbol(variant="color"):
    # the "o" of the wordmark, scaled up as a symbol: rounded-square room with the agent inside
    t, rc = 52, 56
    x, y, w = 24, 22, 208
    l, r_, top, bot = x + t / 2, x + w - t / 2, y + t / 2, y + w - t / 2
    cs = stroke_outline([(l, top), (r_, top), (r_, bot), (l, bot)], t, [rc] * 4, closed=True)
    cs.sort(key=lambda c: -abs(area(sample(c))))
    ring = to_d(orient(cs[0], True)) + to_d(orient(cs[1], False))
    q = 52
    agent = rrect_d(128 - q / 2, 128 - 2 - q / 2, q, q, 6)
    if variant == "color":
        body = f'<path fill="{VIOLET}" d="{ring}"/><path fill="{GREEN}" d="{agent}"/>'
    elif variant == "tile":
        body = (f'<rect width="256" height="256" rx="56" fill="{VIOLET}"/>'
                f'<g transform="translate(128 128) scale(0.68) translate(-128 -128)">'
                f'<path fill="{WHITE}" d="{ring}"/><path fill="{GREEN}" d="{agent}"/></g>')
    else:
        body = f'<path fill="#000000" d="{ring}{agent}"/>'
    return svg("0 0 256 256", body, "Cyno — o centro")


def wordmark_paths(tp, x0, base, agent_in_o=False):
    paths, width = tp.word("cyno", x0, base, [22, 26, 26])
    extra = ""
    if agent_in_o:
        # o is the last glyph: its box = [x0+width-116, base-xh .. base]
        ox = x0 + width - 116
        q = 26
        extra = rrect_d(ox + 58 - q / 2, base - tp.xh / 2 - q / 2, q, q, 4)
    return paths, width, extra


def lockup(symbol_svg_body, name, fill=VIOLET, agent_in_o=False, office=False, symbol=True):
    tp = Type()
    base = 128 + tp.xh / 2
    x0 = 256 + 40 if symbol else 16
    paths, width, extra = wordmark_paths(tp, x0, base, agent_in_o)
    body = symbol_svg_body if symbol else ""
    body += f'<path fill="{fill}" d="{"".join(paths)}"/>'
    if extra:
        body += f'<path fill="{GREEN}" d="{extra}"/>'
    end = x0 + width
    if office:
        # "office": the same drawing at 46 % size (thinner by scale), sharing the baseline of "cyno"
        k = 0.46
        sm = Type()
        op, ow = sm.word("office", 0, 0, [24, 10, 24, 24, 24])
        ox = end + 34
        body += (f'<path fill="{fill}" transform="translate({f(ox)} {f(base)}) scale({k})" '
                 f'd="{"".join(op)}"/>')
        end = ox + ow * k
    w = int(math.ceil(end + 16))
    return svg(f"0 0 {w} 256", body, name)


def inner_body(svgtext):
    a = svgtext.index("</title>") + len("</title>")
    b = svgtext.rindex("</svg>")
    return svgtext[a:b]


if __name__ == "__main__":
    write("a-sala-c.svg", concept_a("color"))
    write("a-sala-c-tile.svg", concept_a("tile"))
    write("a-sala-c-black.svg", concept_a("mono"))
    write("a-sala-c-lockup.svg", lockup(inner_body(concept_a("color")), "Cyno — Sala C, assinatura"))

    write("b-equipe-c.svg", concept_b("color"))
    write("b-equipe-c-square.svg", concept_b("color", centre="square"))
    write("b-equipe-c-tile.svg", concept_b("tile"))
    write("b-equipe-c-black.svg", concept_b("mono"))
    write("b-equipe-c-lockup.svg", lockup(inner_body(concept_b("color")), "Cyno — Equipe em C, assinatura"))

    write("c-centro.svg", concept_c_symbol("color"))
    write("c-centro-tile.svg", concept_c_symbol("tile"))
    write("c-centro-black.svg", concept_c_symbol("mono"))
    write("c-wordmark.svg", lockup("", "Cyno — palavra", agent_in_o=True, symbol=False))
