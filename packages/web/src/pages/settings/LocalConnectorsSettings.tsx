import { CONNECTORS_STDIO_PATH, type ConnectorsStdioResponse } from "@cyno/shared";
import { useEffect, useRef, useState } from "react";
import { describeError, requestJson } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, SettingSwitch } from "./SettingsOption";

/**
 * Seção da plataforma "Conectores locais": os conectores de comando (stdio) e a instalação de apps
 * rodam programas NESTA máquina, com as permissões do usuário do servidor. Esta chave liga ou desliga
 * (ação do dono, atrás da senha); sem escolha sua, vale o `CONNECTORS_STDIO` do `.env`.
 */
export function LocalConnectorsSettings() {
  const [data, setData] = useState<ConnectorsStdioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reset = useAsyncAction();

  useEffect(() => {
    alive.current = true;
    requestJson<ConnectorsStdioResponse>(CONNECTORS_STDIO_PATH).then(
      (next) => alive.current && setData(next),
      (caught: unknown) => alive.current && setError(describeError(caught)),
    );
    return () => {
      alive.current = false;
    };
  }, []);

  if (!data) {
    return (
      <div className="settings__groups">
        <ErrorText testId="settings-stdio-error">{error}</ErrorText>
        {!error && (
          <p className="settings__card-hint" role="status">
            Lendo se os conectores locais estão ligados…
          </p>
        )}
      </div>
    );
  }

  const set = async (enabled: boolean) => {
    const next = await requestJson<ConnectorsStdioResponse>(CONNECTORS_STDIO_PATH, { method: "PUT", body: { enabled } });
    if (alive.current) setData(next);
    return next;
  };
  const backToDefault = async () => {
    const next = await reset.run(() => requestJson<ConnectorsStdioResponse>(CONNECTORS_STDIO_PATH, { method: "DELETE" }));
    if (next && alive.current) setData(next);
  };
  return (
    <div className="settings__groups" data-testid="settings-stdio">
      <section className="settings__card">
        <OptionHead
          title="Conectores locais (comando na máquina)"
          seal="plataforma"
          line={`Conectores do tipo comando e apps instalados pela Biblioteca rodam programas nesta máquina, com as permissões do usuário do servidor. Ligue só numa rede em que você confia. ${data.source === "env" ? `Agora vale o padrão do servidor (${data.envDefault ? "ligado" : "desligado"} pelo .env).` : `Você escolheu; o padrão do servidor (.env) é ${data.envDefault ? "ligado" : "desligado"}.`}`}
        />
        <SettingSwitch
          title="Permitir conectores locais"
          line="Ligado: dá para cadastrar conectores de comando e instalar apps. Desligado: nada local roda (os conectores por endereço, HTTP, seguem funcionando)."
          seal="plataforma"
          checked={data.enabled}
          inherited={data.source === "env"}
          onToggle={set}
          testId="settings-stdio-switch"
        />
        {data.source === "owner" && (
          <div>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void backToDefault()} disabled={reset.pending} data-testid="settings-stdio-reset">
              Voltar ao padrão do servidor
            </button>
            <ErrorText>{reset.error}</ErrorText>
          </div>
        )}
      </section>
    </div>
  );
}
