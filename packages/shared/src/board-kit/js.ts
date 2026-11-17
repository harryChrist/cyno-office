/**
 * JS do kit do Quadro (string, sem dependências, sem rede). Roda dentro do iframe isolado da página e
 * define `window.Quadro`. REGRAS para editar: o texto fica dentro de um template literal, então NÃO use
 * crases nem `${` aqui dentro (use concatenação) e nunca escreva a sequência de fechar a tag de script.
 *
 * Protocolo com a página-mãe (quem monta o iframe), todas as mensagens por `postMessage` (a origem do
 * iframe é "null", então use targetOrigin "*" e confira `event.source === iframe.contentWindow`):
 *   iframe para a mãe:  { type: "quadro:ready" }                 a página carregou (mande os dados atuais se mudaram desde o srcdoc)
 *                       { type: "quadro:height", height: n }      altura do conteúdo em px (opcional: use para ajustar a altura do iframe)
 *                       { type: "quadro:error", message: "..." }  erro de script da página do agente (opcional: mostre um aviso)
 *   mãe para o iframe:  { type: "quadro:data", data: <json>, meta?: <BoardMeta> }  dados novos: o kit troca Quadro.data e chama os Quadro.onData
 */
export const BOARD_KIT_JS = String.raw`
(function () {
  "use strict";
  var Q = (window.Quadro = {});
  var boot = { data: {}, meta: {} };
  try {
    var node = document.getElementById("quadro-data");
    if (node) boot = JSON.parse(node.textContent || "{}");
  } catch (e) {}
  Q.data = boot.data == null ? {} : boot.data;
  Q.meta = boot.meta || {};

  /* ---------- Básicos ---------- */
  function $(el) { return typeof el === "string" ? document.querySelector(el) : el; }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  function pathGet(obj, path) {
    var parts = Array.isArray(path) ? path : String(path).split(".");
    for (var i = 0; i < parts.length; i++) {
      if (obj == null) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }
  Q.esc = esc;
  /** Valor dentro de Quadro.data por caminho com pontos ("obras.0.nome"); devolve fallback se faltar. */
  Q.get = function (path, fallback) {
    var v = pathGet(Q.data, path);
    return v === undefined || v === null ? fallback : v;
  };
  /** Lista de linhas: aceita array ou objeto por id ({ "a": {...} } vira [{ id: "a", ... }]). */
  Q.rows = function (v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      return Object.keys(v).map(function (k) {
        var r = v[k];
        if (r && typeof r === "object" && !Array.isArray(r)) return "id" in r ? r : Object.assign({ id: k }, r);
        return { id: k, value: r };
      });
    }
    return [];
  };
  Q.countBy = function (rows, key) {
    var m = {};
    Q.rows(rows).forEach(function (r) {
      var k = typeof key === "function" ? key(r) : pathGet(r, key);
      k = k == null || k === "" ? "(vazio)" : String(k);
      m[k] = (m[k] || 0) + 1;
    });
    return Object.keys(m).map(function (k) { return { label: k, value: m[k] }; }).sort(function (a, b) { return b.value - a.value; });
  };
  Q.sum = function (rows, key) {
    return Q.rows(rows).reduce(function (s, r) {
      var n = Number(typeof key === "function" ? key(r) : pathGet(r, key));
      return s + (isFinite(n) ? n : 0);
    }, 0);
  };
  Q.render = function (el, html) { el = $(el); if (el) el.innerHTML = html; return el; };

  /* ---------- Formatação pt-BR ---------- */
  var nfCache = {};
  function nf(opts) {
    var k = JSON.stringify(opts);
    return nfCache[k] || (nfCache[k] = new Intl.NumberFormat("pt-BR", opts));
  }
  function isNum(v) { return v !== null && v !== "" && v !== undefined && isFinite(Number(v)); }
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === "number") return new Date(v < 1e11 ? v * 1000 : v);
    var s = String(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }
  var fmt = (Q.fmt = {});
  /** 1234.5 vira "1.234,5". opts: { decimals, compact: true (1,2 mil) }. Ausente vira "-". */
  fmt.number = function (v, opts) {
    if (!isNum(v)) return "-";
    opts = typeof opts === "number" ? { decimals: opts } : opts || {};
    var o = { maximumFractionDigits: opts.decimals == null ? 2 : opts.decimals };
    if (opts.compact) o.notation = "compact";
    else if (opts.decimals != null) o.minimumFractionDigits = opts.decimals;
    return nf(o).format(Number(v));
  };
  /** Fração vira porcentagem: 0.256 vira "25,6%". */
  fmt.percent = function (v, decimals) {
    if (!isNum(v)) return "-";
    return nf({ style: "percent", maximumFractionDigits: decimals == null ? 0 : decimals }).format(Number(v));
  };
  /** "12/11/2026"; opts: { long: true } ("12 de novembro de 2026"), { time: true } (acrescenta a hora). */
  fmt.date = function (v, opts) {
    var d = toDate(v);
    if (!d) return "-";
    opts = opts || {};
    var o = opts.long ? { day: "numeric", month: "long", year: "numeric" } : { day: "2-digit", month: "2-digit", year: "numeric" };
    if (opts.time) { o.hour = "2-digit"; o.minute = "2-digit"; }
    return new Intl.DateTimeFormat("pt-BR", o).format(d);
  };
  /** "há 2 dias", "ontem", "em 3 dias", "agora". */
  fmt.rel = function (v, now) {
    var d = toDate(v);
    if (!d) return "-";
    var diff = d.getTime() - (now ? toDate(now).getTime() : Date.now());
    var abs = Math.abs(diff);
    var rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
    if (abs < 45e3) return "agora";
    if (abs < 36e5) return rtf.format(Math.round(diff / 6e4), "minute");
    if (abs < 864e5) return rtf.format(Math.round(diff / 36e5), "hour");
    var days = Math.round(diff / 864e5);
    if (Math.abs(days) < 30) return rtf.format(days, "day");
    if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), "month");
    return rtf.format(Math.round(days / 365), "year");
  };
  /** Dias inteiros de hoje até a data (negativo = já passou). */
  fmt.daysUntil = function (v) {
    var d = toDate(v);
    if (!d) return null;
    var t = new Date();
    return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
  };

  /* ---------- Peças em HTML (devolvem texto; encaixe com innerHTML) ---------- */
  var TONES = {
    ok: "concluido|concluida|completo|completa|finalizado|finalizada|publicado|publicada|ativo|ativa|ok|feito|feita|pago|paga|aprovado|aprovada|em dia|lancado|lancada|done|active|published|complete|completed",
    info: "em andamento|andamento|traduzindo|revisando|em producao|em progresso|in progress|ongoing|lendo|estudando",
    warn: "pausado|pausada|pendente|aguardando|hiato|em espera|paused|pending|waiting|revisar",
    danger: "cancelado|cancelada|atrasado|atrasada|erro|falhou|abandonado|abandonada|dropado|dropada|error|failed|late|cancelled",
    muted: "rascunho|planejado|novo|draft|todo|a fazer"
  };
  var toneOf = {};
  Object.keys(TONES).forEach(function (t) {
    TONES[t].split("|").forEach(function (w) { toneOf[w] = t; });
  });
  function autoTone(text) {
    var k = norm(text).trim();
    if (toneOf[k]) return toneOf[k];
    var h = 0;
    for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return ["accent", "info", "ok", "warn"][h % 4];
  }
  /** Selo de status. tone: ok | warn | danger | info | accent | muted (sem tone, reconhece palavras comuns de status). */
  Q.badge = function (text, tone) {
    if (text == null || text === "") return "";
    return '<span class="q-badge q-' + esc(tone || autoTone(text)) + '">' + esc(text) + "</span>";
  };
  /** Barra de progresso: value de max (padrão 100). tone opcional; com 100% fica verde. */
  Q.progress = function (value, max, tone) {
    var m = isNum(max) && Number(max) > 0 ? Number(max) : 100;
    if (!isNum(value)) return '<span class="q-muted">-</span>';
    var pct = Math.max(0, Math.min(100, (Number(value) / m) * 100));
    var t = tone || (pct >= 100 ? "ok" : "");
    return '<div class="q-progress' + (t ? " q-" + esc(t) : "") + '"><div class="q-progress-track"><div class="q-progress-bar" style="width:' + pct.toFixed(1) + '%"></div></div><span class="q-progress-label">' + Math.round(pct) + "%</span></div>";
  };
  /** Cartão de número. o: { label, value, hint, delta ("+12%"), trend ("up"|"down"), tone } (value já formatado ou número). */
  Q.stat = function (o) {
    var v = typeof o.value === "number" ? fmt.number(o.value) : o.value == null ? "-" : o.value;
    var trend = o.trend || (typeof o.delta === "string" ? (o.delta.charAt(0) === "+" ? "up" : o.delta.charAt(0) === "-" ? "down" : "") : "");
    return (
      '<div class="q-card q-stat' + (o.tone ? " q-" + esc(o.tone) : "") + '"><div class="q-stat-label">' + esc(o.label) + '</div><div class="q-stat-value">' + esc(v) + "</div>" +
      (o.delta ? '<div class="q-stat-delta ' + esc(trend) + '">' + esc(o.delta) + "</div>" : "") +
      (o.hint ? '<div class="q-stat-hint">' + esc(o.hint) + "</div>" : "") + "</div>"
    );
  };

  /* ---------- Tabela com busca, ordenação e paginação ---------- */
  var collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
  function normCol(c) {
    if (typeof c === "string") c = { key: c };
    var col = Object.assign({ type: "text", sortable: true }, c);
    col.label = col.label == null ? col.key : col.label;
    col.align = col.align || (col.type === "number" || col.type === "percent" ? "r" : "");
    return col;
  }
  function cellValue(col, row) {
    return typeof col.value === "function" ? col.value(row) : pathGet(row, col.key);
  }
  function cellHtml(col, row) {
    var v = cellValue(col, row);
    if (typeof col.render === "function") return col.render(v, row);
    if (v == null || v === "") return '<span class="q-muted">-</span>';
    switch (col.type) {
      case "number": return esc(fmt.number(v, col.decimals));
      case "percent": return esc(fmt.percent(v, col.decimals));
      case "date": return esc(fmt.date(v, col.dateOptions));
      case "rel": return '<span title="' + esc(fmt.date(v, { time: true })) + '">' + esc(fmt.rel(v)) + "</span>";
      case "badge": return Q.badge(v, col.tones && col.tones[v]);
      case "progress": {
        var max = typeof col.max === "string" ? pathGet(row, col.max) : col.max;
        return Q.progress(v, max);
      }
      case "link": {
        var s = String(v);
        var label = col.text ? col.text(row) : s;
        return /^https?:\/\//i.test(s) ? '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>" : esc(label);
      }
      case "html": return String(v);
      default: return esc(v);
    }
  }
  function sortKeyOf(col, row) {
    var v = cellValue(col, row);
    if (v == null || v === "") return null;
    if (col.type === "number" || col.type === "percent" || col.type === "progress") return isNum(v) ? Number(v) : null;
    if (col.type === "date" || col.type === "rel") { var d = toDate(v); return d ? d.getTime() : null; }
    return String(v);
  }
  function Table(el) { this.el = el; this.state = { q: "", sortKey: null, dir: 1, page: 0, pageSize: 25 }; this.items = []; }
  Table.prototype.configure = function (opts) {
    this.opts = opts;
    this.cols = (opts.columns && opts.columns.length ? opts.columns : autoColumns(Q.rows(opts.rows))).map(normCol);
    var st = this.state;
    if (!this.built) {
      st.pageSize = opts.pageSize || 25;
      if (opts.sort) { st.sortKey = typeof opts.sort === "string" ? opts.sort : opts.sort.key; st.dir = opts.sort.dir === "desc" ? -1 : 1; }
    }
    this.build();
  };
  function autoColumns(rows) {
    var keys = [];
    rows.slice(0, 20).forEach(function (r) {
      if (r && typeof r === "object") Object.keys(r).forEach(function (k) { if (keys.indexOf(k) < 0 && keys.length < 8) keys.push(k); });
    });
    return keys;
  }
  Table.prototype.build = function () {
    var self = this, o = this.opts;
    var searchHint = typeof o.search === "string" ? o.search : "Buscar...";
    var sortable = this.cols.filter(function (c) { return c.sortable !== false; });
    this.el.classList.add("q-table-box");
    this.el.innerHTML =
      '<div class="q-toolbar"><input class="q-input" type="search" placeholder="' + esc(searchHint) + '" aria-label="Buscar">' +
      '<select class="q-select q-sort-mobile" aria-label="Ordenar por"><option value="">Ordenar por...</option>' +
      sortable.map(function (c) { return '<option value="' + esc(c.key) + '">' + esc(c.label) + "</option>"; }).join("") +
      '</select><span class="q-spacer"></span><span class="q-muted q-small q-count"></span></div>' +
      '<div class="q-table-wrap"><table class="q-table"><thead><tr>' +
      this.cols.map(function (c) {
        return '<th class="' + (c.sortable !== false ? "sortable " : "") + c.align + '" data-key="' + esc(c.key) + '"' + (c.width ? ' style="width:' + esc(c.width) + '"' : "") + ">" + esc(c.label) + '<span class="q-arrow"></span></th>';
      }).join("") +
      '</tr></thead><tbody></tbody></table></div><div class="q-pager"></div>';
    this.built = true;
    this.input = this.el.querySelector(".q-input");
    this.input.value = this.state.q;
    this.input.addEventListener("input", function () { self.state.q = self.input.value; self.state.page = 0; self.draw(); });
    this.sel = this.el.querySelector(".q-select");
    this.sel.addEventListener("change", function () {
      if (!self.sel.value) return;
      self.state.sortKey = self.sel.value; self.state.dir = 1; self.state.page = 0; self.draw();
    });
    this.el.querySelector("thead").addEventListener("click", function (e) {
      var th = e.target.closest("th.sortable");
      if (th) self.sortBy(th.getAttribute("data-key"));
    });
    this.el.querySelector(".q-pager").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-page]");
      if (b && !b.disabled) { self.state.page = Number(b.getAttribute("data-page")); self.draw(); }
    });
    this.el.querySelector(".q-pager").addEventListener("change", function (e) {
      if (e.target.matches(".q-pagesize")) { self.state.pageSize = Number(e.target.value); self.state.page = 0; self.draw(); }
    });
    this.index();
  };
  Table.prototype.sortBy = function (key) {
    var st = this.state;
    if (st.sortKey === key) st.dir = -st.dir; else { st.sortKey = key; st.dir = 1; }
    st.page = 0;
    this.draw();
  };
  Table.prototype.index = function () {
    var cols = this.cols, keys = this.opts.searchKeys;
    this.items = Q.rows(this.opts.rows).map(function (row) {
      var parts = [];
      if (keys) keys.forEach(function (k) { parts.push(pathGet(row, k)); });
      else cols.forEach(function (c) { parts.push(cellValue(c, row)); });
      return { row: row, hay: norm(parts.join(" ")) };
    });
    this.draw();
  };
  Table.prototype.update = function (rows) {
    this.opts.rows = rows;
    this.index();
  };
  Table.prototype.draw = function () {
    var self = this, st = this.state, cols = this.cols;
    var terms = norm(st.q).split(/\s+/).filter(Boolean);
    var list = terms.length ? this.items.filter(function (it) { return terms.every(function (t) { return it.hay.indexOf(t) >= 0; }); }) : this.items.slice();
    var sc = st.sortKey ? cols.filter(function (c) { return c.key === st.sortKey; })[0] : null;
    if (sc) {
      var keyed = list.map(function (it) { return { it: it, k: sortKeyOf(sc, it.row) }; });
      keyed.sort(function (a, b) {
        if (a.k === null && b.k === null) return 0;
        if (a.k === null) return 1;
        if (b.k === null) return -1;
        var c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : collator.compare(String(a.k), String(b.k));
        return c * st.dir;
      });
      list = keyed.map(function (x) { return x.it; });
    }
    var total = list.length, size = st.pageSize, pages = Math.max(1, Math.ceil(total / size));
    if (st.page >= pages) st.page = pages - 1;
    var from = st.page * size, slice = list.slice(from, from + size);
    var body = slice.length
      ? slice.map(function (it) {
          return "<tr>" + cols.map(function (c, i) {
            return '<td class="' + c.align + (i === 0 || c.main ? " q-cell-main" : "") + '" data-label="' + esc(c.label) + '">' + cellHtml(c, it.row) + "</td>";
          }).join("") + "</tr>";
        }).join("")
      : '<tr class="q-empty-row"><td colspan="' + cols.length + '">' + esc(terms.length ? "Nada encontrado para essa busca." : this.opts.empty || "Sem registros ainda.") + "</td></tr>";
    this.el.querySelector("tbody").innerHTML = body;
    this.el.querySelectorAll("th.sortable").forEach(function (th) {
      th.querySelector(".q-arrow").textContent = th.getAttribute("data-key") === st.sortKey ? (st.dir > 0 ? "\u25B4" : "\u25BE") : "";
    });
    this.sel.value = st.sortKey || "";
    this.input.parentNode.style.display = this.opts.search === false || (this.opts.search === undefined && this.items.length <= 10) ? "none" : "";
    this.el.querySelector(".q-count").textContent = terms.length ? total + " de " + this.items.length : this.items.length + (this.items.length === 1 ? " registro" : " registros");
    this.pager(total, pages, from, slice.length);
  };
  Table.prototype.pager = function (total, pages, from, n) {
    var st = this.state, box = this.el.querySelector(".q-pager");
    if (total <= 10) { box.innerHTML = ""; return; }
    var nums = [];
    for (var p = 0; p < pages; p++) if (p === 0 || p === pages - 1 || Math.abs(p - st.page) <= 1) nums.push(p);
    var html = "", last = -1;
    nums.forEach(function (p) {
      if (last >= 0 && p - last > 1) html += '<span class="q-muted">...</span>';
      html += '<button class="q-btn' + (p === st.page ? " on" : "") + '" data-page="' + p + '">' + (p + 1) + "</button>";
      last = p;
    });
    box.innerHTML =
      "<span>" + (from + 1) + " a " + (from + n) + " de " + fmt.number(total) + "</span>" +
      '<span class="q-pages"><button class="q-btn" data-page="' + (st.page - 1) + '"' + (st.page === 0 ? " disabled" : "") + '>Anterior</button>' + html +
      '<button class="q-btn" data-page="' + (st.page + 1) + '"' + (st.page >= pages - 1 ? " disabled" : "") + ">Próxima</button></span>" +
      '<select class="q-select q-pagesize" aria-label="Linhas por página">' +
      [10, 25, 50, 100].map(function (s) { return '<option value="' + s + '"' + (s === st.pageSize ? " selected" : "") + ">" + s + " por página</option>"; }).join("") + "</select>";
  };
  /**
   * Tabela em el: Quadro.table("#t", { rows, columns, search, sort, pageSize, empty }).
   * columns: lista de { key, label, type: text|number|percent|date|rel|badge|progress|link|html, align, sortable, width,
   * decimals, tones, max, render(valor, linha) -> HTML }. Chamar de novo no mesmo el atualiza as linhas e mantém busca, ordem e página.
   */
  Q.table = function (el, opts) {
    el = $(el);
    if (!el) return null;
    var t = el._qtable;
    if (!t) { t = el._qtable = new Table(el); }
    t.configure(opts || {});
    return t;
  };

  /* ---------- Gráficos em SVG ---------- */
  var ro = window.ResizeObserver ? new ResizeObserver(function (entries) {
    entries.forEach(function (en) {
      var el = en.target, w = Math.round(en.contentRect.width);
      if (el._qdraw && el._qw !== w) { el._qw = w; el._qdraw(); }
    });
  }) : null;
  function host(el, draw) {
    el = $(el);
    if (!el) return null;
    el.classList.add("q-chart");
    el._qdraw = draw;
    el._qw = Math.round(el.clientWidth);
    draw();
    if (ro && !el._qro) { el._qro = 1; ro.observe(el); }
    return el;
  }
  function color(i, c) { return c || "var(--q-c" + ((i % 8) + 1) + ")"; }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function short(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "..." : s; }
  function legend(items) {
    return '<div class="q-legend">' + items.map(function (it) { return '<span><i style="background:' + it.color + '"></i>' + esc(it.label) + "</span>"; }).join("") + "</div>";
  }
  function pairs(o) {
    if (o.data && o.data.length && typeof o.data[0] === "object") return o.data;
    var values = o.values || o.data || [];
    return values.map(function (v, i) { return { label: o.labels ? o.labels[i] : String(i + 1), value: v }; });
  }
  var fmtAxis = function (v) { return fmt.number(v, { compact: true, decimals: 1 }); };
  var C = (Q.chart = {});
  /** Barras. o: { data: [{ label, value, color? }] ou labels + values, horizontal, height, format(valor) }. */
  C.bar = function (el, o) {
    o = o || {};
    return host(el, function () {
      var box = $(el), w = Math.max(240, box.clientWidth || 600), data = pairs(o).filter(function (d) { return isNum(d.value); });
      if (!data.length) { box.innerHTML = '<div class="q-empty">Sem dados para o gráfico.</div>'; return; }
      var f = o.format || function (v) { return fmt.number(v, { compact: true, decimals: 1 }); };
      var max = niceMax(Math.max.apply(null, data.map(function (d) { return Number(d.value); }))), svg = "", h;
      if (o.horizontal) {
        var longest = Math.max.apply(null, data.map(function (d) { return String(d.label).length; })), rowH = 28, lw = Math.min(Math.round(w * 0.4), Math.max(24, Math.ceil(longest * 6.6) + 14)), right = 56;
        h = data.length * rowH + 8;
        data.forEach(function (d, i) {
          var y = 4 + i * rowH, bw = Math.max(2, ((w - lw - right) * Number(d.value)) / max);
          svg += '<text x="' + (lw - 10) + '" y="' + (y + 15) + '" text-anchor="end">' + esc(short(d.label, Math.floor(lw / 6.5))) + "</text>" +
            '<rect class="q-bar" x="' + lw + '" y="' + (y + 3) + '" width="' + bw.toFixed(1) + '" height="16" rx="4" fill="' + color(o.colorEach ? i : 0, d.color) + '"><title>' + esc(d.label + ": " + f(d.value)) + "</title></rect>" +
            '<text x="' + (lw + bw + 7) + '" y="' + (y + 15) + '">' + esc(f(d.value)) + "</text>";
        });
      } else {
        h = o.height || 230;
        var left = 44, top = 14, bottom = 30, pw = w - left - 8, ph = h - top - bottom, band = pw / data.length, bw2 = Math.max(3, Math.min(48, band * 0.62));
        for (var g = 0; g <= 4; g++) {
          var gy = top + ph - (ph * g) / 4;
          svg += '<line class="' + (g ? "q-grid-line" : "q-axis-line") + '" x1="' + left + '" x2="' + (w - 8) + '" y1="' + gy + '" y2="' + gy + '"/><text x="' + (left - 8) + '" y="' + (gy + 4) + '" text-anchor="end">' + esc(fmtAxis((max * g) / 4)) + "</text>";
        }
        var every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(pw / 64))));
        data.forEach(function (d, i) {
          var bh = (ph * Number(d.value)) / max, x = left + band * i + (band - bw2) / 2, y = top + ph - bh;
          svg += '<rect class="q-bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw2.toFixed(1) + '" height="' + Math.max(1, bh).toFixed(1) + '" rx="4" fill="' + color(o.colorEach ? i : 0, d.color) + '"><title>' + esc(d.label + ": " + f(d.value)) + "</title></rect>";
          if (i % every === 0) svg += '<text x="' + (x + bw2 / 2).toFixed(1) + '" y="' + (h - 10) + '" text-anchor="middle">' + esc(short(d.label, Math.max(4, Math.floor((band * every) / 6.5)))) + "</text>";
          if (data.length <= 10) svg += '<text x="' + (x + bw2 / 2).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="middle" style="fill:var(--ui-text-2)">' + esc(f(d.value)) + "</text>";
        });
      }
      box.innerHTML = '<svg viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" role="img">' + svg + "</svg>";
    });
  };
  /** Linha(s). o: { series: [{ name, data: [numeros] | [{ x, y }], color? }], labels, height, format } (ou data: [numeros] para uma série). */
  C.line = function (el, o) {
    o = o || {};
    return host(el, function () {
      var box = $(el), w = Math.max(240, box.clientWidth || 600), h = o.height || 230;
      var series = (o.series || [{ name: o.name || "", data: o.data || o.values || [] }]).map(function (s) {
        var pts = (s.data || []).map(function (p, i) {
          return typeof p === "object" && p ? { x: p.x, y: Number(p.y) } : { x: o.labels ? o.labels[i] : i + 1, y: Number(p) };
        }).filter(function (p) { return isFinite(p.y); });
        return { name: s.name, color: s.color, pts: pts };
      });
      var n = Math.max.apply(null, series.map(function (s) { return s.pts.length; }).concat([0]));
      if (n < 1) { box.innerHTML = '<div class="q-empty">Sem dados para o gráfico.</div>'; return; }
      var f = o.format || fmtAxis, all = [];
      series.forEach(function (s) { s.pts.forEach(function (p) { all.push(p.y); }); });
      var lo = Math.min(0, Math.min.apply(null, all)), max = niceMax(Math.max.apply(null, all.concat([lo + 1])));
      if (o.zero === false) lo = Math.min.apply(null, all);
      var left = 44, top = 14, bottom = 30, pw = w - left - 12, ph = h - top - bottom, svg = "";
      var sy = function (v) { return top + ph - (ph * (v - lo)) / (max - lo || 1); };
      var sx = function (i) { return left + (n === 1 ? pw / 2 : (pw * i) / (n - 1)); };
      for (var g = 0; g <= 4; g++) {
        var v = lo + ((max - lo) * g) / 4;
        svg += '<line class="' + (g ? "q-grid-line" : "q-axis-line") + '" x1="' + left + '" x2="' + (w - 12) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/><text x="' + (left - 8) + '" y="' + (sy(v) + 4) + '" text-anchor="end">' + esc(fmtAxis(v)) + "</text>";
      }
      var ref = series.filter(function (s) { return s.pts.length === n; })[0] || series[0];
      var every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 70))));
      ref.pts.forEach(function (p, i) {
        if (i % every === 0) {
          var lab = typeof p.x === "string" && toDate(p.x) && /\d{4}-\d{2}-\d{2}/.test(p.x) ? fmt.date(p.x).slice(0, 5) : p.x;
          svg += '<text x="' + sx(i) + '" y="' + (h - 10) + '" text-anchor="middle">' + esc(short(lab, 10)) + "</text>";
        }
      });
      series.forEach(function (s, si) {
        var c = color(si, s.color), d = s.pts.map(function (p, i) { return (i ? "L" : "M") + sx(i).toFixed(1) + " " + sy(p.y).toFixed(1); }).join("");
        if (series.length === 1 && s.pts.length > 1) svg += '<path d="' + d + "L" + sx(s.pts.length - 1).toFixed(1) + " " + sy(lo) + "L" + sx(0).toFixed(1) + " " + sy(lo) + 'Z" fill="' + c + '" opacity=".13"/>';
        svg += '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
        if (s.pts.length <= 40) s.pts.forEach(function (p, i) { svg += '<circle cx="' + sx(i).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="3.5" fill="var(--ui-bg)" stroke="' + c + '" stroke-width="2"><title>' + esc((s.name ? s.name + " - " : "") + p.x + ": " + f(p.y)) + "</title></circle>"; });
      });
      box.innerHTML = '<svg viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" role="img">' + svg + "</svg>" +
        (series.length > 1 ? legend(series.map(function (s, i) { return { label: s.name, color: color(i, s.color) }; })) : "");
    });
  };
  /** Rosca. o: { data: [{ label, value, color? }], center: { value, label } (padrão: total) }. A legenda mostra a parte de cada fatia. */
  C.donut = function (el, o) {
    o = o || {};
    return host(el, function () {
      var box = $(el), data = pairs(o).filter(function (d) { return isNum(d.value) && Number(d.value) > 0; });
      var total = data.reduce(function (s, d) { return s + Number(d.value); }, 0);
      if (!total) { box.innerHTML = '<div class="q-empty">Sem dados para o gráfico.</div>'; return; }
      var s = 190, r = 74, sw = 26, circ = 2 * Math.PI * r, acc = 0, svg = "";
      data.forEach(function (d, i) {
        var len = (Number(d.value) / total) * circ;
        svg += '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" fill="none" stroke="' + color(i, d.color) + '" stroke-width="' + sw + '" stroke-dasharray="' + Math.max(0, len - 1.5).toFixed(2) + " " + (circ - Math.max(0, len - 1.5)).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 ' + s / 2 + " " + s / 2 + ')"><title>' + esc(d.label + ": " + fmt.number(d.value)) + "</title></circle>";
        acc += len;
      });
      var c = o.center || { value: fmt.number(total, { compact: true, decimals: 1 }), label: "total" };
      svg += '<text class="q-donut-center-value" x="' + s / 2 + '" y="' + (s / 2 + 6) + '" text-anchor="middle">' + esc(c.value) + '</text><text x="' + s / 2 + '" y="' + (s / 2 + 24) + '" text-anchor="middle">' + esc(c.label) + "</text>";
      box.innerHTML = '<div class="q-donut"><svg viewBox="0 0 ' + s + " " + s + '" width="' + s + '" height="' + s + '" role="img">' + svg + "</svg>" +
        '<div class="q-legend">' + data.map(function (d, i) {
          return '<span><i style="background:' + color(i, d.color) + '"></i>' + esc(d.label) + ' <b class="q-num">' + esc(fmt.number(d.value)) + '</b> <span class="q-muted">' + esc(fmt.percent(Number(d.value) / total)) + "</span></span>";
        }).join("") + "</div></div>";
    });
  };

  /* ---------- Dados ao vivo e ciclo de vida ---------- */
  var handlers = [];
  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }
  function reportError(e) {
    try { console.error(e); window.parent.postMessage({ type: "quadro:error", message: String((e && e.message) || e) }, "*"); } catch (x) {}
  }
  function run(fn) { try { fn(Q.data, Q.meta); } catch (e) { reportError(e); } }
  /** fn(data, meta) roda já (quando o HTML termina de carregar) e de novo toda vez que os dados mudam. Devolve uma função para cancelar. */
  Q.onData = function (fn) {
    handlers.push(fn);
    whenReady(function () { if (handlers.indexOf(fn) >= 0) run(fn); });
    return function () { var i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); };
  };
  /** Roda fn quando o HTML terminou de carregar (para scripts colocados antes dos elementos). */
  Q.ready = whenReady;

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== window.parent || !m || typeof m !== "object") return;
    if (m.type === "quadro:data") {
      Q.data = m.data == null ? {} : m.data;
      if (m.meta) Q.meta = m.meta;
      handlers.slice().forEach(run);
    }
  });
  window.addEventListener("error", function (e) { reportError(e.error || e.message); });
  var lastH = 0;
  function sendHeight() {
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h !== lastH) { lastH = h; try { window.parent.postMessage({ type: "quadro:height", height: h }, "*"); } catch (x) {} }
  }
  whenReady(function () {
    if (ro) new ResizeObserver(function () { requestAnimationFrame(sendHeight); }).observe(document.body);
    sendHeight();
    try { window.parent.postMessage({ type: "quadro:ready" }, "*"); } catch (x) {}
  });
})();
`;
