import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { ForYouBoard } from "./ForYouBoard";
import "./foryou.css";
import "./foryouDash.css";

/**
 * Página "Para você": tudo que precisa do usuário (aprovar, editar, recusar, responder,
 * copiar), do workspace atual e ao vivo. Os itens vêm do GET /for-you e dos eventos foryou:*.
 */
export function ForYouPage() {
  const items = useOfficeStore((state) => state.forYou);
  const types = useOfficeStore((state) => state.forYouTypes);
  const office = useOfficeStore((state) => state.office);
  const error = useOfficeStore((state) => state.forYouError);
  // Trocar de workspace recomeça a página (filtros e rascunhos eram do anterior).
  const workspaceId = useNavStore((state) => state.workspaceId);
  return (
    <section className="page page--foryou page--fill" aria-labelledby="page-title-para-voce" data-testid="page-para-voce">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-para-voce" className="page__title">
            Aprovações
          </h2>
          <p className="page__subtitle">Tudo que precisa de você: aprovar, editar, recusar, responder, copiar e deixar nota para o time.</p>
        </div>
      </header>
      {items ? (
        <ForYouBoard key={workspaceId ?? ""} items={items} types={types} office={office} />
      ) : (
        <div className="page__body">
          <p className="page__empty" role={error ? "alert" : undefined}>
            {error ? `Não deu para carregar as Aprovações: ${error}` : "Carregando…"}
          </p>
        </div>
      )}
    </section>
  );
}
