import "./demo.css";

/** O selo "Demonstração", sempre à vista: tudo aqui é de mentira e nada é gravado. */
export function SeloDemo() {
  const sair = new URL(window.location.href);
  sair.searchParams.delete("demo");
  sair.searchParams.delete("seed");
  sair.searchParams.delete("now");
  return (
    <div className="selo-demo" role="status" data-testid="selo-demo">
      <span className="selo-demo__ponto" aria-hidden="true" />
      <strong>Demonstração</strong>
      <span className="selo-demo__nota">dados de mentira, nada é gravado</span>
      <a className="selo-demo__sair" href={`${sair.pathname}${sair.search}${sair.hash}`}>
        Sair
      </a>
    </div>
  );
}
