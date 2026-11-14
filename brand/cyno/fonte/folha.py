#!/usr/bin/env python3
"""Build the final check sheet HTML for the Cyno kit. Usage: folha.py <final_dir> <out.html>"""
import base64
import os
import sys

F, OUT = sys.argv[1], sys.argv[2]


def uri(name, mime="image/svg+xml"):
    with open(os.path.join(F, name), "rb") as fh:
        return f"data:{mime};base64,{base64.b64encode(fh.read()).decode()}"


def img(name, h, w=None, pixel=False, mime="image/svg+xml"):
    style = f"height:{h}px;" + (f"width:{w}px;" if w else "") + ("image-rendering:pixelated;" if pixel else "")
    return f'<img src="{uri(name, mime)}" style="{style}">'


def cell(content, label):
    return f'<div class="c">{content}<span>{label}</span></div>'


def ladder(dark):
    out = []
    for s in (16, 24, 32, 48, 64, 128, 256, 512):
        if s <= 24:
            out.append(cell(img("cyno-mark-small.svg", s, s, pixel=True), f"{s} px · corte pequeno"))
        else:
            out.append(cell(img("cyno-mark-escuro.svg" if dark else "cyno-mark.svg", s), f"{s} px"))
    return "".join(out)


tiles = "".join(cell(img(f"png/cyno-tile-{s}.png", s, mime="image/png"), f"{s} px") for s in (16, 32, 48, 180, 192, 512))
zoom = "".join(cell(img(n, 128, 128, pixel=True, mime="image/png"), l) for n, l in (
    ("png/cyno-tile-16.png", "16 px ampliado (favicon)"), ("png/cyno-tile-32.png", "32 px ampliado"),
    ("png/cyno-tile-48.png", "48 px ampliado")))
mono = (cell(f'<div style="color:#0B0D1A">{img("cyno-mark-mono.svg", 96)}</div>', "uma cor · preto")
        + cell(f'<div style="color:#fff;background:#0B0D1A;padding:8px;border-radius:8px">{img("cyno-mark-mono.svg", 96)}</div>', "uma cor · branco"))
sw = [("#6D5CF5", "violeta sólido · paredes / azulejo"), ("#8B7CFF", "violeta acento · paredes no escuro"),
      ("#AB9FFF", "face interna (claro)"), ("#D6D0FF", "face interna (escuro/azulejo)"),
      ("#3DDC97", "verde agente · topo do cubo"), ("#2FBF80", "verde · face esquerda"), ("#1F9E68", "verde · face direita"),
      ("#14162B", "tinta · texto no claro"), ("#E8EAF6", "texto no escuro"), ("#0B0D1A", "fundo do app")]
swatches = "".join(f'<div class="sw"><i style="background:{h}"></i><b>{h}</b><span>{l}</span></div>' for h, l in sw)

# the mono file uses currentColor: inline it so the colour inherits (an <img> would render it black)
with open(os.path.join(F, "cyno-mark-mono.svg")) as fh:
    mono_svg = fh.read().replace("<svg ", '<svg style="height:96px;width:96px" ', 1)
mono = (cell(f'<div style="color:#0B0D1A">{mono_svg}</div>', "uma cor · currentColor preto")
        + cell(f'<div style="color:#fff;background:#0B0D1A;padding:8px;border-radius:8px">{mono_svg}</div>',
               "uma cor · currentColor branco"))

html = f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Cyno — folha final</title><style>
body{{margin:0;font:13px/1.4 system-ui,sans-serif;background:#f4f4f7;color:#14162B}}
h1{{font-weight:500;margin:0 0 4px}} h2{{font:600 11px system-ui;letter-spacing:.12em;text-transform:uppercase;color:#6b6f8a;margin:28px 0 10px}}
.wrap{{padding:36px 40px}} .row{{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-end;padding:22px;border-radius:14px}}
.light{{background:#fff}} .dark{{background:#0B0D1A;color:#b4b8d4}} .c{{display:flex;flex-direction:column;align-items:center;gap:8px}}
.c span{{font-size:11px;color:#8a8fb3}} .sw{{display:flex;flex-direction:column;width:128px;font-size:11px}}
.sw i{{display:block;height:44px;border-radius:8px;border:1px solid #0001}} .sw b{{margin-top:6px}} .sw span{{color:#6b6f8a}}
.half{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
</style></head><body><div class="wrap">
<h1>Cyno — kit final</h1><div style="color:#6b6f8a">Conceito A · Sala C: o C é a sala isométrica do escritório, de porta aberta, com um agente verde trabalhando dentro.</div>
<h2>Símbolo · fundo claro (16–24 px usam o corte pequeno)</h2><div class="row light">{ladder(False)}</div>
<h2>Símbolo · fundo escuro (#0B0D1A)</h2><div class="row dark">{ladder(True)}</div>
<h2>Assinatura</h2><div class="half"><div class="row dark">{img("cyno-lockup.svg", 96)}</div><div class="row light">{img("cyno-lockup-claro.svg", 96)}</div></div>
<div class="half" style="margin-top:16px"><div class="row dark">{img("cyno-lockup.svg", 32)}</div><div class="row light">{img("cyno-lockup-claro.svg", 32)}</div></div>
<h2>Ícone do app (PNG no tamanho real)</h2><div class="row dark">{tiles}</div>
<div class="row light" style="margin-top:16px">{tiles}</div>
<h2>Pixels ampliados</h2><div class="row light">{zoom}</div>
<h2>Uma cor</h2><div class="row light">{mono}</div>
<h2>Cores</h2><div class="row light">{swatches}</div>
</div></body></html>"""
with open(OUT, "w") as fh:
    fh.write(html)
print("wrote", OUT)
