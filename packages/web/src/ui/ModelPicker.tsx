import type { OpenRouterModel } from "@cyno/shared";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  contextLabel,
  defaultToolsFilter,
  highlightParts,
  INVALID_ID_HINT,
  listStateLine,
  PROGRAM_INVALID_ID_HINT,
  PROGRAM_UNLISTED_HINT,
  modelBadges,
  NO_TOOLS_WARNING,
  PAGE_SIZE,
  priceBadge,
  providerCounts,
  queryWords,
  searchModels,
  SORT_LABELS,
  suggestionGroups,
  typedId,
  UNLISTED_HINT,
  type ModelFilters,
  type ModelSource,
  type ModelSort,
  type PriceFilter,
} from "./modelSearch";
import "./modelPicker.css";

type Props = {
  /** A lista inteira do OpenRouter (pode vir vazia: a digitação livre continua funcionando). */
  models: readonly OpenRouterModel[];
  /** O id escolhido hoje ("" = nenhum). */
  value: string;
  /** O id foi digitado e ainda não foi conferido na lista (só o "Verificar" confere). */
  unlisted?: boolean;
  onChoose: (id: string) => void;
  /** Se existir, aparece "Limpar" ao lado do modelo escolhido. */
  onClear?: () => void;
  /** Quando a lista foi lida (ISO) e o relógio da tela, para "lista lida há 3 h". */
  readAt?: string;
  now?: number;
  /** O botão "Atualizar modelos" (some se não vier). */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** A última leitura da lista falhou: a mensagem aparece junto ao botão. */
  loadError?: string | null;
  /** A lista ainda está sendo buscada na primeira vez. */
  loading?: boolean;
  disabled?: boolean;
  testId: string;
  inputId?: string;
  describedBy?: string;
  placeholder?: string;
  /** De onde vem a lista: o OpenRouter (padrão) ou os modelos do próprio programa (sem preço, sem filtro de preço/ferramentas; a digitação livre vale `provedor/modelo`). */
  source?: ModelSource;
};

type Option =
  | { kind: "model"; key: string; model: OpenRouterModel }
  | { kind: "typed"; key: string; id: string; listed: boolean }
  | { kind: "action"; key: string; label: string; run: () => void }
  | { kind: "more"; key: string; remaining: number };
type Row = { kind: "header"; key: string; text: string } | { kind: "hint"; key: string; text: string } | { kind: "option"; option: Option };

const PRICE_CHIPS: { id: PriceFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "free", label: "Gratuitos" },
  { id: "paid", label: "Pagos" },
];

function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {highlightParts(text, words).map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </>
  );
}

function Badges({ model }: { model: OpenRouterModel }) {
  const badges = modelBadges(model);
  return (
    <>
      {badges.map((badge) => (
        <span key={badge.label} className={`mpick__badge mpick__badge--${badge.tone}`}>
          {badge.label}
        </span>
      ))}
    </>
  );
}

/**
 * O seletor de modelos do OpenRouter (OpenClaw e Hermes): um combobox com busca enquanto digita, filtros rápidos,
 * ordenação, a lista inteira em páginas e a digitação livre de um id. As regras ficam em `modelSearch.ts` (puras).
 */
export function ModelPicker({ models, value, unlisted, onChoose, onClear, readAt, now, onRefresh, refreshing, loadError, loading, disabled, testId, inputId, describedBy, placeholder, source = "openrouter" }: Props) {
  const program = source === "program";
  const unlistedHint = program ? PROGRAM_UNLISTED_HINT : UNLISTED_HINT;
  const base = useId().replace(/:/g, "");
  const listboxId = `${base}-list`;
  const optionId = (index: number) => `${base}-opt-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQueryState] = useState("");
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState<PriceFilter>("all");
  const [toolsChoice, setToolsChoice] = useState<boolean | null>(null);
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState<ModelSort>("relevance");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [active, setActive] = useState(-1);
  const [mountedAt] = useState(() => Date.now());

  const tools = toolsChoice ?? defaultToolsFilter(models);
  const hasToolsData = useMemo(() => models.some((model) => model.tools !== undefined), [models]);
  const filters = useMemo<ModelFilters>(() => ({ price, tools, provider }), [price, tools, provider]);
  const words = useMemo(() => queryWords(query), [query]);
  const hits = useMemo(() => searchModels(models, { query, filters, sort }), [models, query, filters, sort]);
  const providers = useMemo(() => providerCounts(models.filter((model) => (price === "free" ? model.price.free : price === "paid" ? !model.price.free : true) && !(tools && model.tools === false))), [models, price, tools]);
  const typed = useMemo(() => typedId(query, models, source), [query, models, source]);
  const chosen = useMemo(() => models.find((model) => model.id === value), [models, value]);
  const searching = words.length > 0;

  const resetPaging = (hasQuery: boolean) => {
    setLimit(PAGE_SIZE);
    setActive(hasQuery ? 0 : -1);
  };
  const setQuery = (next: string) => {
    setQueryState(next);
    setOpen(true);
    resetPaging(queryWords(next).length > 0);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const choose = (id: string) => {
    onChoose(id);
    setQueryState("");
    close();
  };
  const quick = (apply: () => void) => {
    apply();
    resetPaging(searching);
  };

  // As linhas da lista: com a busca vazia, as sugestões no topo (escolhido hoje, Gratuitos, DeepSeek) e depois todos; com busca, só os resultados e a linha de digitação livre.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const add = (option: Option) => out.push({ kind: "option", option });
    // Sugestões só na busca vazia e sem filtro/ordem escolhidos: quem filtra ou ordena quer ver a lista.
    if (!searching && price === "all" && !provider && sort === "relevance") {
      const groups = program ? { free: [], deepseek: [] } : suggestionGroups(models, filters);
      if (chosen) {
        out.push({ kind: "header", key: "h-chosen", text: "Escolhido hoje" });
        add({ kind: "model", key: `chosen:${chosen.id}`, model: chosen });
      }
      if (groups.free.length > 0) {
        out.push({ kind: "header", key: "h-free", text: "Gratuitos" });
        for (const model of groups.free) add({ kind: "model", key: `free:${model.id}`, model });
        add({ kind: "action", key: "a-free", label: "Ver todos os gratuitos", run: () => quick(() => setPrice("free")) });
      }
      if (groups.deepseek.length > 0) {
        out.push({ kind: "header", key: "h-deepseek", text: "DeepSeek" });
        for (const model of groups.deepseek) add({ kind: "model", key: `deepseek:${model.id}`, model });
        add({ kind: "action", key: "a-deepseek", label: "Ver todos do DeepSeek", run: () => quick(() => setProvider("deepseek")) });
      }
      if (models.length > 0) out.push({ kind: "header", key: "h-all", text: `${program ? "Todos os modelos do programa" : "Todos os modelos"} (${hits.length.toLocaleString("pt-BR")})` });
    }
    for (const model of hits.slice(0, limit)) add({ kind: "model", key: `all:${model.id}`, model });
    if (hits.length > limit) add({ kind: "more", key: "more", remaining: hits.length - limit });
    if (models.length > 0 && hits.length === 0) out.push({ kind: "hint", key: "none", text: searching ? "Nenhum modelo com esses filtros e essa busca." : "Nenhum modelo com esses filtros." });
    if (searching) {
      if (typed.state === "invalid") out.push({ kind: "hint", key: "invalid", text: `“${typed.text}” não pode ser usado como id. ${program ? PROGRAM_INVALID_ID_HINT : INVALID_ID_HINT}` });
      else if (typed.state === "unlisted" || (typed.state === "listed" && !hits.some((model) => model.id === typed.id))) add({ kind: "typed", key: "typed", id: typed.id, listed: typed.state === "listed" });
    }
    if (models.length === 0) out.push({ kind: "hint", key: "empty", text: program ? "O programa não deu uma lista de modelos: escreva provedor/modelo e use como está." : "A lista ainda não foi lida: dá para escrever o id do modelo (provedor/modelo) e usar como está." });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `quick` só mexe em estados estáveis
  }, [searching, models, filters, chosen, hits, limit, typed, price, provider, sort, program]);
  const options = useMemo(() => rows.flatMap((row) => (row.kind === "option" ? [row.option] : [])), [rows]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId depende só de `base`
  }, [active, open]);

  const run = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === "model") choose(option.model.id);
    else if (option.kind === "typed") choose(option.id);
    else if (option.kind === "action") option.run();
    else setLimit((current) => current + PAGE_SIZE);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return setOpen(true);
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current < 0 ? (step === 1 ? 0 : options.length - 1) : (current + step + options.length) % options.length));
    } else if (event.key === "Home" && open && options.length > 0 && active >= 0) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && open && options.length > 0 && active >= 0) {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      // Sem linha ativa, o que foi digitado vale se for um id (colar e Enter).
      if (active < 0 && (typed.state === "unlisted" || typed.state === "listed")) return choose(typed.id);
      run(options[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const ageNow = now ?? mountedAt;
  const stateLine = loading && models.length === 0 ? "Lendo a lista de modelos…" : listStateLine(readAt, models.length, ageNow);
  const activeOption = open && active >= 0 && active < options.length ? optionId(active) : undefined;
  let counter = -1;

  return (
    <div
      ref={rootRef}
      className="mpick"
      data-testid={testId}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      {value && (
        <div className="mpick__chosen" data-testid={`${testId}-chosen`}>
          <div className="mpick__chosen-line">
            <code className="mpick__id" data-testid={`${testId}-chosen-id`}>
              {value}
            </code>
            {chosen && <span className="mpick__name">{chosen.name}</span>}
            {onClear && (
              <button type="button" className="ui-link mpick__clear" onClick={onClear} disabled={disabled} data-testid={`${testId}-clear`}>
                Limpar
              </button>
            )}
          </div>
          {chosen && !program ? (
            <div className="mpick__meta">
              <span className={chosen.price.free ? "mpick__free" : undefined}>{priceBadge(chosen.price)}</span>
              <span>{contextLabel(chosen.contextLength)}</span>
              <Badges model={chosen} />
            </div>
          ) : (
            !chosen && unlisted && <p className="mpick__note">{unlistedHint}</p>
          )}
          {chosen?.tools === false && !program && <p className="mpick__note mpick__note--warn">{NO_TOOLS_WARNING}</p>}
        </div>
      )}

      <div className="mpick__field">
        <input
          id={inputId}
          className="ui-input mpick__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption}
          aria-describedby={describedBy}
          aria-label={inputId ? undefined : "Buscar modelo"}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          value={query}
          placeholder={placeholder ?? (value ? "Trocar: buscar um modelo ou colar um id…" : "Buscar um modelo ou colar um id…")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          data-testid={`${testId}-input`}
        />
        {open && (
          <button type="button" className="ui-button ui-button--ghost ui-button--small mpick__close" onClick={close} data-testid={`${testId}-close`}>
            Fechar
          </button>
        )}
      </div>

      <div className="mpick__status" data-testid={`${testId}-state`}>
        <span>{stateLine}</span>
        {onRefresh && (
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onRefresh} disabled={disabled || refreshing} aria-busy={refreshing} data-testid={`${testId}-refresh`}>
            {refreshing ? "Lendo…" : "Atualizar modelos"}
          </button>
        )}
      </div>
      {loadError && (
        <p className="mpick__note mpick__note--bad" role="alert" data-testid={`${testId}-load-error`}>
          Não consegui ler a lista de modelos: {loadError} Você ainda pode escrever o id do modelo e usá-lo.
        </p>
      )}

      {open && (
        <div className="mpick__panel" data-testid={`${testId}-panel`}>
          {!program && (
          <div className="mpick__filters" role="group" aria-label="Filtros dos modelos">
            {PRICE_CHIPS.map((chip) => (
              <button key={chip.id} type="button" className="mpick__chip" aria-pressed={price === chip.id} onClick={() => quick(() => setPrice(chip.id))} data-testid={`${testId}-chip-${chip.id}`}>
                {chip.label}
              </button>
            ))}
            <button
              type="button"
              className="mpick__chip"
              aria-pressed={tools}
              disabled={!hasToolsData}
              title={hasToolsData ? "Só modelos que aceitam ferramentas (os agentes do Cyno usam)" : "A lista lida não informa o suporte a ferramentas"}
              onClick={() => quick(() => setToolsChoice(!tools))}
              data-testid={`${testId}-chip-tools`}
            >
              Com ferramentas
            </button>
          </div>
          )}
          <div className="mpick__selects">
            <label className="mpick__select">
              <span>Provedor</span>
              <select className="ui-input" value={provider} onChange={(event) => quick(() => setProvider(event.currentTarget.value))} data-testid={`${testId}-provider`}>
                <option value="">Todos ({providers.reduce((sum, entry) => sum + entry.count, 0).toLocaleString("pt-BR")})</option>
                {provider && !providers.some((entry) => entry.provider === provider) && <option value={provider}>{provider} (0)</option>}
                {providers.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {entry.provider} ({entry.count})
                  </option>
                ))}
              </select>
            </label>
            <label className="mpick__select">
              <span>Ordem</span>
              <select className="ui-input" value={sort} onChange={(event) => quick(() => setSort(event.currentTarget.value as ModelSort))} data-testid={`${testId}-sort`}>
                {(Object.keys(SORT_LABELS) as ModelSort[])
                  .filter((key) => (!program || key === "relevance" || key === "name") && (key !== "newest" || models.some((model) => model.created !== undefined)))
                  .map((key) => (
                    <option key={key} value={key}>
                      {SORT_LABELS[key]}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <ul id={listboxId} role="listbox" aria-label={program ? "Modelos do programa" : "Modelos do OpenRouter"} className="mpick__list" data-testid={`${testId}-list`}>
            {rows.map((row) => {
              if (row.kind === "header")
                return (
                  <li key={row.key} role="presentation" className="mpick__group">
                    {row.text}
                  </li>
                );
              if (row.kind === "hint")
                return (
                  <li key={row.key} role="presentation" className="mpick__hint">
                    {row.text}
                  </li>
                );
              counter += 1;
              const index = counter;
              const option = row.option;
              const isActive = index === active;
              const common = { id: optionId(index), role: "option", "aria-selected": isActive, className: `mpick__option${isActive ? " is-active" : ""}`, onMouseMove: () => setActive(index), onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(), onClick: () => run(option) } as const;
              if (option.kind === "model") {
                const model = option.model;
                return (
                  <li key={option.key} {...common} data-testid={`${testId}-option`} data-model-id={model.id} data-current={model.id === value ? "true" : undefined}>
                    <span className="mpick__line">
                      <code className="mpick__id">
                        <Marked text={model.id} words={words} />
                      </code>
                      {model.id === value && <span className="mpick__badge mpick__badge--info">escolhido</span>}
                    </span>
                    <span className="mpick__name">
                      <Marked text={model.name} words={words} />
                    </span>
                    {!program && (
                      <span className="mpick__meta">
                        <span className={model.price.free ? "mpick__free" : undefined}>{priceBadge(model.price)}</span>
                        <span>{contextLabel(model.contextLength)}</span>
                        <Badges model={model} />
                      </span>
                    )}
                  </li>
                );
              }
              if (option.kind === "typed")
                return (
                  <li key={option.key} {...common} className={`${common.className} mpick__option--typed`} data-testid={`${testId}-typed`}>
                    <span className="mpick__line">
                      Usar ‘<code className="mpick__id">{option.id}</code>’ como está
                    </span>
                    <span className="mpick__meta">{option.listed ? "Este modelo está na lista, mas os filtros o escondem." : unlistedHint}</span>
                  </li>
                );
              if (option.kind === "action")
                return (
                  <li key={option.key} {...common} className={`${common.className} mpick__option--action`}>
                    {option.label}
                  </li>
                );
              return (
                <li key={option.key} {...common} className={`${common.className} mpick__option--action`} data-testid={`${testId}-more`}>
                  Mostrar mais ({option.remaining.toLocaleString("pt-BR")} {option.remaining === 1 ? "restante" : "restantes"})
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

