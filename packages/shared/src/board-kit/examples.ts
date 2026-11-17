/**
 * Dois exemplos completos e diferentes entre si (entram no guia da IA e servem de prova do kit):
 * um catálogo com tabela pesquisável e outro de acompanhamento de estudos. Sem crases nem `${` aqui dentro.
 */

export const BOARD_EXAMPLE_CATALOG_HTML = String.raw`<main class="q-page">
  <header class="q-header"><h1>Catálogo de obras</h1><p class="q-muted" id="sub"></p></header>
  <section class="q-grid" id="stats"></section>
  <section class="q-cols-2">
    <div class="q-card"><h3>Obras por status</h3><div id="by-status"></div></div>
    <div class="q-card"><h3>Obras por idioma</h3><div id="by-lang"></div></div>
  </section>
  <section class="q-section"><div class="q-section-title"><h2>Todas as obras</h2></div><div id="works"></div></section>
</main>
<script>
Quadro.onData(function (d) {
  var works = Quadro.rows(d.works);
  var done = works.filter(function (w) { return w.status === "Concluída"; }).length;
  Quadro.render("#sub", "Atualizado " + Quadro.fmt.rel(d.updatedAt));
  Quadro.render("#stats",
    Quadro.stat({ label: "Obras", value: works.length }) +
    Quadro.stat({ label: "Em andamento", value: works.length - done, tone: "info" }) +
    Quadro.stat({ label: "Concluídas", value: done, tone: "ok" }) +
    Quadro.stat({ label: "Capítulos publicados", value: Quadro.sum(works, "lastChapter") }));
  Quadro.chart.donut("#by-status", { data: Quadro.countBy(works, "status") });
  Quadro.chart.bar("#by-lang", { horizontal: true, data: Quadro.countBy(works, "lang") });
  Quadro.table("#works", { rows: works, search: "Buscar obra...", sort: { key: "updatedAt", dir: "desc" }, columns: [
    { key: "name", label: "Obra" },
    { key: "status", label: "Status", type: "badge" },
    { key: "lastChapter", label: "Último cap.", type: "number" },
    { key: "progress", label: "Progresso", type: "progress", value: function (w) { return w.lastChapter; }, max: "totalChapters" },
    { key: "updatedAt", label: "Atualizada", type: "rel" } ] });
});
</script>`;

export const BOARD_EXAMPLE_STUDY_HTML = String.raw`<style>.hero{display:flex;flex-direction:row;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}.big{font-size:44px;font-weight:800;line-height:1}</style>
<main class="q-page">
  <header class="q-header hero"><div><h1 id="name"></h1><p class="q-muted" id="when"></p></div><div><span class="big q-num" id="days"></span> <span class="q-muted">dias para a prova</span></div></header>
  <section class="q-grid" id="stats"></section>
  <section class="q-cols-2">
    <div class="q-section"><div class="q-section-title"><h2>Matérias</h2></div><div class="q-card q-stack" id="subjects"></div></div>
    <div class="q-section"><div class="q-section-title"><h2>Datas importantes</h2></div><div class="q-card"><ul class="q-timeline" id="dates"></ul></div></div>
  </section>
  <section class="q-section"><div class="q-section-title"><h2>O que falta estudar</h2><small id="left"></small></div><div class="q-card"><ul class="q-list" id="todo"></ul></div></section>
</main>
<script>
Quadro.onData(function (d) {
  var exam = d.exam || {}, subs = Quadro.rows(d.subjects), topics = Quadro.rows(d.topics);
  var open = topics.filter(function (t) { return !t.done; });
  var done = Quadro.sum(subs, "done"), total = Quadro.sum(subs, "total");
  Quadro.render("#name", Quadro.esc(exam.name || "Meu estudo"));
  Quadro.render("#when", "Prova em " + Quadro.fmt.date(exam.date, { long: true }));
  Quadro.render("#days", Quadro.fmt.daysUntil(exam.date) == null ? "-" : Quadro.fmt.daysUntil(exam.date));
  Quadro.render("#stats",
    Quadro.stat({ label: "Progresso geral", value: Quadro.fmt.percent(total ? done / total : 0), tone: "ok" }) +
    Quadro.stat({ label: "Tópicos estudados", value: done + " de " + total }) +
    Quadro.stat({ label: "Falta estudar", value: open.length, tone: open.length ? "warn" : "ok" }));
  Quadro.render("#subjects", subs.map(function (s) {
    return '<div><div class="q-row q-spread"><b>' + Quadro.esc(s.name) + '</b><span class="q-small q-muted">' + s.done + "/" + s.total + "</span></div>" + Quadro.progress(s.done, s.total) + "</div>"; }).join(""));
  var next = true;
  Quadro.render("#dates", Quadro.rows(d.milestones).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).map(function (m) {
    var late = !m.done && Quadro.fmt.daysUntil(m.date) < 0, cls = m.done ? "done" : late ? "late" : next ? "now" : "";
    if (!m.done && !late) next = false;
    return '<li class="q-tl-item ' + cls + '"><span class="q-tl-date">' + Quadro.fmt.date(m.date) + " - " + Quadro.fmt.rel(m.date) + '</span><span class="q-tl-title">' + Quadro.esc(m.title) + "</span></li>"; }).join(""));
  Quadro.render("#left", open.length + " tópicos");
  Quadro.render("#todo", open.length ? open.map(function (t) {
    return '<li><span class="q-check"></span><span class="q-grow">' + Quadro.esc(t.text) + '<span class="q-sub">' + Quadro.esc(t.subject) + "</span></span>" + Quadro.badge(t.priority, t.priority === "alta" ? "danger" : "muted") + "</li>"; }).join("") : '<li class="q-muted">Tudo estudado.</li>');
});
</script>`;

const WORK_NAMES = ["A Torre Esquecida", "Reino das Cinzas", "O Último Mago", "Sombras de Neon", "Flor de Lótus Negra", "Caçador de Eras", "Crônicas do Vento", "Herdeira do Dragão", "Academia Estelar", "Rei dos Mares", "Lâmina Silenciosa", "Jardim das Marés"];
const WORK_STATUS = ["Em andamento", "Em andamento", "Em andamento", "Concluída", "Pausada", "Hiato"];
const WORK_LANG = ["KO", "JP", "CN", "EN"];

/** Dados do catálogo de exemplo (n obras, objeto por id; determinístico). */
export function exampleCatalogData(count = 300, now = new Date("2026-11-16T12:00:00-03:00")): { updatedAt: string; works: Record<string, Record<string, unknown>> } {
  const works: Record<string, Record<string, unknown>> = {};
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 1; i <= count; i++) {
    const total = 20 + Math.floor(rand() * 380);
    const status = WORK_STATUS[Math.floor(rand() * WORK_STATUS.length)]!;
    const last = status === "Concluída" ? total : Math.floor(total * rand());
    works[`w${String(i).padStart(3, "0")}`] = {
      name: `${WORK_NAMES[i % WORK_NAMES.length]!} ${Math.ceil(i / WORK_NAMES.length)}`,
      status,
      lastChapter: last,
      totalChapters: total,
      lang: WORK_LANG[Math.floor(rand() * WORK_LANG.length)],
      updatedAt: new Date(now.getTime() - Math.floor(rand() * 90 * 86400000)).toISOString(),
    };
  }
  return { updatedAt: now.toISOString(), works };
}

/** Dados do acompanhamento de estudos de exemplo. */
export function exampleStudyData(today = new Date("2026-11-16T12:00:00-03:00")): Record<string, unknown> {
  const day = (offset: number) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
  return {
    exam: { name: "Concurso TRT 2027", date: day(118) },
    subjects: {
      port: { name: "Língua Portuguesa", done: 18, total: 30 },
      dc: { name: "Direito Constitucional", done: 12, total: 40 },
      da: { name: "Direito Administrativo", done: 9, total: 35 },
      inf: { name: "Informática", done: 20, total: 24 },
      rl: { name: "Raciocínio Lógico", done: 4, total: 22 },
    },
    milestones: [
      { date: day(-20), title: "Edital publicado", done: true },
      { date: day(-3), title: "Inscrição paga", done: true },
      { date: day(9), title: "Simulado 1", done: false },
      { date: day(40), title: "Simulado 2", done: false },
      { date: day(118), title: "Prova objetiva", done: false },
    ],
    topics: {
      t1: { text: "Crase e regência verbal", subject: "Língua Portuguesa", done: false, priority: "alta" },
      t2: { text: "Controle de constitucionalidade", subject: "Direito Constitucional", done: false, priority: "alta" },
      t3: { text: "Atos administrativos", subject: "Direito Administrativo", done: false, priority: "média" },
      t4: { text: "Tabelas-verdade e equivalências", subject: "Raciocínio Lógico", done: false, priority: "alta" },
      t5: { text: "Planilhas: funções de busca", subject: "Informática", done: false, priority: "baixa" },
      t6: { text: "Concordância nominal", subject: "Língua Portuguesa", done: true, priority: "média" },
    },
  };
}
