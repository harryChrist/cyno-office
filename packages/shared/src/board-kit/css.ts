/**
 * CSS do kit do Quadro (string). Mesmo visual escuro do app: as variáveis --ui-* abaixo são cópia de
 * packages/web/src/theme/tokens.css (mudou lá, mude aqui). Sem fontes externas: a CSP do iframe só
 * deixa `font-src data:`; a fonte cai para Inter se existir no aparelho, senão a do sistema.
 * Classes prontas (prefixo `q-`): veja BOARD_GUIDE em guide.ts.
 */
export const BOARD_KIT_CSS = String.raw`
:root{
  color-scheme:dark;
  --ui-bg:#0b0d1a;
  --ui-surface:rgba(22,25,48,.72);
  --ui-surface-solid:#15182e;
  --ui-surface-2:#1c2040;
  --ui-surface-3:#252a52;
  --ui-field:#10132a;
  --ui-hover:rgba(255,255,255,.05);
  --ui-border:rgba(255,255,255,.08);
  --ui-border-strong:rgba(255,255,255,.16);
  --ui-text:#e8eaf6;
  --ui-text-2:#b4b8d4;
  --ui-text-3:#8a8fb3;
  --ui-accent:#8b7cff;
  --ui-accent-solid:#6d5cf5;
  --ui-accent-bg:rgba(139,124,255,.14);
  --ui-ok:#3ddc97;--ui-ok-bg:rgba(61,220,151,.12);
  --ui-warn:#f5b544;--ui-warn-bg:rgba(245,181,68,.13);
  --ui-danger:#ff6b81;--ui-danger-bg:rgba(255,107,129,.12);
  --ui-info:#7ab4f3;--ui-info-bg:rgba(122,180,243,.13);
  --ui-bar-track:rgba(255,255,255,.1);
  --ui-radius:12px;--ui-radius-sm:8px;--ui-radius-pill:999px;
  --ui-shadow:0 8px 28px rgba(3,4,14,.45),0 1px 2px rgba(0,0,0,.3);
  --ui-font:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --ui-font-mono:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;
  /* Cores de gráfico, em ordem (as mesmas dos tipos do app). */
  --q-c1:#86b5f2;--q-c2:#62c6c6;--q-c3:#94d077;--q-c4:#bba0f2;--q-c5:#e9a067;--q-c6:#ee8bba;--q-c7:#e8b552;--q-c8:#a2acf2;
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--ui-bg);-webkit-text-size-adjust:100%}
body{
  margin:0;color:var(--ui-text);font:14px/1.55 var(--ui-font);
  background:radial-gradient(1000px 520px at 10% -12%,rgba(109,92,245,.17),transparent 60%),radial-gradient(800px 500px at 100% 110%,rgba(56,120,255,.11),transparent 60%),var(--ui-bg);
  background-attachment:fixed;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere;
}
h1,h2,h3,h4{margin:0;line-height:1.25;font-weight:650;letter-spacing:-.01em}
h1{font-size:24px}h2{font-size:17px}h3{font-size:14px}
p{margin:0}
a{color:var(--ui-accent);text-underline-offset:2px}a:hover{color:var(--ui-text)}
code,kbd,pre{font-family:var(--ui-font-mono);font-size:.92em}
code{background:var(--ui-surface-2);padding:1px 5px;border-radius:5px}
hr{border:0;border-top:1px solid var(--ui-border);margin:20px 0}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--ui-surface-3);border-radius:10px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}

/* ---- Página e seções ---- */
.q-page{max-width:1240px;margin:0 auto;padding:24px 20px 56px;display:flex;flex-direction:column;gap:24px}
.q-header{display:flex;flex-direction:column;gap:6px}
.q-header p{color:var(--ui-text-2);max-width:70ch}
.q-section{display:flex;flex-direction:column;gap:12px;min-width:0}
.q-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.q-section-title h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ui-text-3);font-weight:650}
.q-section-title small{color:var(--ui-text-3);font-size:12px}
.q-muted{color:var(--ui-text-3)}
.q-small{font-size:12px}
.q-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.q-spread{justify-content:space-between}
.q-stack{display:flex;flex-direction:column;gap:8px}
.q-num{font-variant-numeric:tabular-nums}

/* ---- Grades ---- */
.q-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))}
.q-grid-wide{grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}
.q-cols-2{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.q-cols-3{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr))}
.q-cols-2>*,.q-cols-3>*,.q-grid>*{min-width:0}
@media (max-width:760px){.q-cols-2,.q-cols-3,.q-grid-wide{grid-template-columns:minmax(0,1fr)}.q-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.q-stat-value{font-size:24px}.q-card{padding:14px}.q-page{padding:16px 14px 40px;gap:20px}h1{font-size:21px}}

/* ---- Cartões ---- */
.q-card{
  background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:var(--ui-radius);padding:16px;
  box-shadow:var(--ui-shadow);backdrop-filter:blur(10px) saturate(140%);min-width:0;
}
.q-card>h3{margin-bottom:10px;color:var(--ui-text-2);font-weight:600}
.q-stat{display:flex;flex-direction:column;gap:4px;position:relative;overflow:hidden}
.q-stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--q-tone,var(--ui-accent));opacity:.9}
.q-stat-label{font-size:12px;color:var(--ui-text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.q-stat-value{font-size:30px;line-height:1.1;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.q-stat-hint{font-size:12px;color:var(--ui-text-3)}
.q-stat-delta{font-size:12px;font-weight:600;color:var(--ui-text-3);display:inline-flex;gap:4px;align-items:center}
.q-stat-delta.up{color:var(--ui-ok)}.q-stat-delta.down{color:var(--ui-danger)}
.q-stat.q-ok{--q-tone:var(--ui-ok)}.q-stat.q-warn{--q-tone:var(--ui-warn)}.q-stat.q-danger{--q-tone:var(--ui-danger)}.q-stat.q-info{--q-tone:var(--ui-info)}

/* ---- Selos ---- */
.q-badge{
  display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:var(--ui-radius-pill);font-size:12px;font-weight:600;line-height:1.5;
  white-space:nowrap;color:var(--ui-text-2);background:var(--ui-hover);border:1px solid var(--ui-border);
}
.q-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}
.q-badge.q-ok{color:var(--ui-ok);background:var(--ui-ok-bg);border-color:transparent}
.q-badge.q-warn{color:var(--ui-warn);background:var(--ui-warn-bg);border-color:transparent}
.q-badge.q-danger{color:var(--ui-danger);background:var(--ui-danger-bg);border-color:transparent}
.q-badge.q-info{color:var(--ui-info);background:var(--ui-info-bg);border-color:transparent}
.q-badge.q-accent{color:var(--ui-accent);background:var(--ui-accent-bg);border-color:transparent}
.q-badge.q-muted{color:var(--ui-text-3)}

/* ---- Barra de progresso ---- */
.q-progress{display:flex;align-items:center;gap:10px;min-width:120px}
.q-progress-track{flex:1;height:8px;border-radius:var(--ui-radius-pill);background:var(--ui-bar-track);overflow:hidden;min-width:60px}
.q-progress-bar{height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,var(--ui-accent-solid),var(--ui-accent));transition:width .4s ease-out}
.q-progress.q-ok .q-progress-bar{background:linear-gradient(90deg,#27b97c,var(--ui-ok))}
.q-progress.q-warn .q-progress-bar{background:linear-gradient(90deg,#d99a25,var(--ui-warn))}
.q-progress.q-danger .q-progress-bar{background:linear-gradient(90deg,#d94a62,var(--ui-danger))}
.q-progress-label{font-size:12px;color:var(--ui-text-2);font-variant-numeric:tabular-nums;min-width:38px;text-align:right}

/* ---- Lista ---- */
.q-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.q-list>li{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--ui-border)}
.q-list>li:last-child{border-bottom:0}
.q-list .q-grow{flex:1;min-width:0}
.q-list .q-sub{display:block;font-size:12px;color:var(--ui-text-3)}
.q-check{flex:none;width:18px;height:18px;border-radius:6px;border:1.5px solid var(--ui-border-strong);display:inline-grid;place-items:center;color:transparent;font-size:12px;line-height:1}
.q-done .q-check{background:var(--ui-ok);border-color:var(--ui-ok);color:#06210f}
.q-done .q-grow{color:var(--ui-text-3);text-decoration:line-through;text-decoration-color:var(--ui-border-strong)}

/* ---- Linha do tempo / datas ---- */
.q-timeline{list-style:none;margin:0;padding:0 0 0 18px;position:relative;display:flex;flex-direction:column;gap:14px}
.q-timeline::before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:2px;background:var(--ui-border-strong);border-radius:2px}
.q-tl-item{position:relative;display:grid;gap:2px}
.q-tl-item::before{content:"";position:absolute;left:-18px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--ui-surface-3);border:2px solid var(--ui-border-strong)}
.q-tl-item.done::before{background:var(--ui-ok);border-color:var(--ui-ok)}
.q-tl-item.now::before{background:var(--ui-accent);border-color:var(--ui-accent);box-shadow:0 0 0 4px var(--ui-accent-bg)}
.q-tl-item.late::before{background:var(--ui-danger);border-color:var(--ui-danger)}
.q-tl-date{font-size:12px;color:var(--ui-text-3);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.q-tl-title{font-weight:600}
.q-tl-text{font-size:13px;color:var(--ui-text-2)}

/* ---- Tabela (Quadro.table) ---- */
.q-table-box{display:flex;flex-direction:column;gap:12px;min-width:0}
.q-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.q-toolbar .q-spacer{flex:1}
.q-input,.q-select{
  background:var(--ui-field);color:var(--ui-text);border:1px solid var(--ui-border-strong);border-radius:var(--ui-radius-sm);
  padding:8px 11px;font:inherit;min-height:36px;
}
.q-input{flex:1 1 220px;max-width:380px}
.q-input::placeholder{color:var(--ui-text-3)}
.q-input:focus,.q-select:focus{outline:none;border-color:var(--ui-accent);box-shadow:0 0 0 3px var(--ui-accent-bg)}
.q-btn{
  background:var(--ui-surface-2);color:var(--ui-text);border:1px solid var(--ui-border-strong);border-radius:var(--ui-radius-sm);
  padding:6px 12px;font:inherit;font-weight:600;min-height:34px;cursor:pointer;transition:background .12s,border-color .12s;
}
.q-btn:hover:not(:disabled){background:var(--ui-surface-3)}
.q-btn:disabled{opacity:.4;cursor:default}
.q-btn.on{background:var(--ui-accent-bg);border-color:var(--ui-accent);color:var(--ui-accent)}
.q-table-wrap{border:1px solid var(--ui-border);border-radius:var(--ui-radius);overflow:auto;background:var(--ui-surface);max-width:100%}
table.q-table{width:100%;border-collapse:collapse;min-width:100%}
.q-table th{
  position:sticky;top:0;z-index:1;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:650;color:var(--ui-text-3);
  padding:11px 14px;background:var(--ui-surface-solid);border-bottom:1px solid var(--ui-border-strong);white-space:nowrap;user-select:none;
}
.q-table th.sortable{cursor:pointer}.q-table th.sortable:hover{color:var(--ui-text)}
.q-table th .q-arrow{display:inline-block;width:10px;margin-left:4px;color:var(--ui-accent)}
.q-table td{padding:11px 14px;border-bottom:1px solid var(--ui-border);vertical-align:middle}
.q-table tbody tr:last-child td{border-bottom:0}
.q-table tbody tr:hover td{background:var(--ui-hover)}
.q-table .r{text-align:right;font-variant-numeric:tabular-nums}
.q-table .c{text-align:center}
.q-table td.q-cell-main{font-weight:600}
.q-table .q-empty-row td{text-align:center;color:var(--ui-text-3);padding:32px 14px}
.q-pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between;color:var(--ui-text-3);font-size:12px}
.q-pager .q-pages{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.q-pager .q-btn{min-width:34px;padding:4px 8px}
.q-sort-mobile{display:none}
@media (max-width:640px){
  .q-sort-mobile{display:inline-block}
  .q-input{max-width:none;flex-basis:100%}
  .q-table-wrap{border:0;background:transparent;overflow:visible}
  table.q-table,.q-table tbody,.q-table tr,.q-table td{display:block;width:100%}
  .q-table thead{display:none}
  .q-table tbody{display:flex;flex-direction:column;gap:10px}
  .q-table tbody tr{background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:var(--ui-radius);padding:6px 14px;box-shadow:var(--ui-shadow)}
  .q-table tbody tr:hover td{background:transparent}
  .q-table td{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid var(--ui-border);text-align:right}
  .q-table td::before{content:attr(data-label);color:var(--ui-text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:650;text-align:left;flex:none}
  .q-table td.q-cell-main{font-size:15px}
  .q-table td.q-cell-main::before{display:none}
  .q-table td.q-cell-main{justify-content:flex-start;text-align:left}
  .q-table .q-progress{min-width:0;width:55%}
  .q-table .q-empty-row td::before{display:none}
  .q-table .q-empty-row{background:transparent;border:0;box-shadow:none}
}

/* ---- Gráficos (SVG de Quadro.chart.*) ---- */
.q-chart{width:100%;min-height:80px;position:relative}
.q-chart svg{display:block;width:100%;height:auto;overflow:visible}
.q-chart text{fill:var(--ui-text-3);font:11px var(--ui-font)}
.q-chart .q-grid-line{stroke:var(--ui-border);stroke-width:1}
.q-chart .q-axis-line{stroke:var(--ui-border-strong);stroke-width:1}
.q-chart .q-bar{transition:opacity .12s}.q-chart .q-bar:hover{opacity:.78}
.q-chart .q-donut-center-value{fill:var(--ui-text);font:700 24px var(--ui-font)}
.q-donut{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.q-donut svg{width:190px;height:190px;flex:none}
.q-donut .q-legend{flex:1;min-width:150px;flex-direction:column;margin:0;gap:9px;font-size:13px}
.q-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12px;color:var(--ui-text-2)}
.q-legend span{display:inline-flex;gap:6px;align-items:center}
.q-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.q-empty{padding:28px 14px;text-align:center;color:var(--ui-text-3);border:1px dashed var(--ui-border-strong);border-radius:var(--ui-radius)}
`;
