import type { PushDevice } from "@cyno/shared";
import { useCallback, useEffect, useState } from "react";
import { describeError } from "../../api/client";
import { disablePush, enablePush, pushApi, readPushState, type PushState } from "../../attention/push";
import { notificationPermission } from "../../attention/notify";
import { PUSH_OPTIONAL_NOTE, pushDeviceKind, pushHelpFor } from "../../attention/pushHelp";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";

const STATE_BADGE: Record<PushState, { tone: "on" | "off" | "warn" | "value"; text: string }> = {
  insecure: { tone: "warn", text: "Precisa de https" },
  unsupported: { tone: "off", text: "Sem suporte" },
  blocked: { tone: "warn", text: "Bloqueado" },
  off: { tone: "off", text: "Desligado" },
  on: { tone: "on", text: "Ligado" },
};

const STATE_HINT: Record<PushState, string> = {
  insecure: "Este endereço não é seguro (http no IP da rede).",
  unsupported: "Este navegador não tem o que é preciso.",
  blocked: "O navegador bloqueou as notificações deste site. Só você pode liberar.",
  off: "Ligar pede a permissão de notificação do navegador.",
  on: "Com o site fechado, o aviso chega mesmo com o navegador fechado.",
};

/** Detalhe de cada estado, num bloco recolhido (só os estados que têm o que explicar). */
const STATE_MORE: Partial<Record<PushState, { summary: string; text: string }>> = {
  insecure: { summary: "Como resolver", text: "O navegador só deixa o aviso com o site fechado funcionar em endereço seguro. Abra o Cyno pelo endereço https do dono (ou por localhost, no próprio computador) e volte aqui." },
  unsupported: { summary: "No iPhone e no iPad", text: "Adicione o Cyno à tela de início (Compartilhar, depois Adicionar à Tela de Início) e abra por lá." },
};

const dateLabel = (iso: string): string => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** O passo a passo (por aparelho) para liberar a permissão, mais o botão que relê o navegador. */
function PushHelpBlock({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
  const help = pushHelpFor(pushDeviceKind(typeof navigator === "undefined" ? "" : navigator.userAgent));
  return (
    <div className="settings__push-help" data-testid="settings-push-help">
      <details className="settings__more">
        <summary>Como liberar no navegador</summary>
        <p>
          <strong>{help.title}</strong>
        </p>
        {help.why && <p>{help.why}</p>}
        <ol className="settings__push-steps">
          {help.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p data-testid="settings-push-optional">{PUSH_OPTIONAL_NOTE}</p>
      </details>
      <div className="settings__actions">
        <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={onRetry} data-testid="settings-push-retry">
          Tentar de novo
        </button>
      </div>
    </div>
  );
}

/**
 * "Avisar com o site fechado": o aviso chega por Web Push, mesmo sem nenhuma aba do Cyno aberta. Mostra o estado deste
 * aparelho, liga e desliga, manda um aviso de teste e lista os aparelhos inscritos (cada um com "Remover"). Só avisa o que
 * espera você e que já passaria pelos filtros de Avisos; com o site aberto e visível, valem o aviso na tela e o som.
 */
export function PushSettings() {
  const [state, setState] = useState<PushState | null>(null);
  const [endpoint, setEndpoint] = useState<string | undefined>();
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** O pedido de permissão foi dispensado ou não foi respondido (o navegador ainda não bloqueou de vez). */
  const [notGiven, setNotGiven] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [local, list] = await Promise.all([readPushState(), pushApi.devices().catch(() => ({ devices: [] as PushDevice[] }))]);
    setState(local.state);
    setEndpoint(local.endpoint);
    setDevices(list.devices);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lê o estado do navegador e do servidor ao abrir a tela
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      const next = await enablePush();
      await refresh();
      setNotGiven(next === "off");
      if (next === "blocked") setNote("O navegador bloqueou as notificações deste site.");
      else if (next === "off") setNote("A permissão não foi dada, então o aviso continua desligado.");
    });

  /** Relê a permissão do navegador (ela pode ter mudado fora da página) e, se estiver liberada, segue a inscrição. */
  const retry = () =>
    run(async () => {
      const local = await readPushState();
      if (local.state === "off" && notificationPermission() === "granted") {
        const next = await enablePush();
        await refresh();
        setNotGiven(false);
        setNote(next === "on" ? "Pronto: o aviso está ligado neste aparelho." : "Ainda não deu para ligar. Confira os passos acima.");
        return;
      }
      await refresh();
      setNotGiven(local.state === "off");
      setNote(local.state === "blocked" ? "O navegador ainda está bloqueando as notificações deste site." : local.state === "on" ? "O aviso já está ligado neste aparelho." : "A permissão ainda não foi dada. Toque em Ligar neste aparelho e escolha Permitir.");
    });

  const turnOff = () =>
    run(async () => {
      await disablePush();
      await refresh();
    });

  const sendTest = () =>
    run(async () => {
      const result = await pushApi.test(endpoint);
      if (result.removed > 0) await refresh();
      setNote(result.sent > 0 ? "Aviso de teste enviado. Ele deve aparecer em alguns segundos." : result.removed > 0 ? "Esta inscrição não vale mais e foi removida. Ligue de novo." : "Não foi possível mandar o aviso de teste agora.");
    });

  const removeDevice = (id: string) =>
    run(async () => {
      await pushApi.removeDevice(id);
      await refresh();
    });

  const badge = state ? STATE_BADGE[state] : null;
  const canAct = state === "off" || state === "on";

  return (
    <section className="settings__card" data-testid="settings-attention-push">
      <OptionHead
        title="Avisar com o site fechado"
        seal="plataforma"
        line="Avisa no celular ou no computador mesmo sem nenhuma aba aberta, só o que espera você."
        state={badge ? <StateBadge tone={badge.tone}>{badge.text}</StateBadge> : null}
      />
      <details className="settings__more">
        <summary>O que entra e o que não entra</summary>
        <p>Respeita o que você ligou em “O que avisa”, o silêncio e o “não perturbe”. Com o site aberto e visível, vale o aviso na tela.</p>
      </details>
      {state && (
        <p className="settings__card-hint" data-testid="settings-push-hint" data-state={state}>
          {STATE_HINT[state]}
        </p>
      )}
      {state && STATE_MORE[state] && (
        <details className="settings__more">
          <summary>{STATE_MORE[state]?.summary}</summary>
          <p>{STATE_MORE[state]?.text}</p>
        </details>
      )}
      {(state === "off" || state === "on") && (
        <details className="settings__more">
          <summary>O que o navegador exige</summary>
          <p>Endereço seguro (https ou localhost): em http://192.168.x.x o navegador não deixa. No iPhone só funciona com o site adicionado à tela de início.</p>
        </details>
      )}
      {(state === "blocked" || (state === "off" && notGiven)) && <PushHelpBlock busy={busy} onRetry={() => void retry()} />}
      {canAct && (
        <div className="settings__actions">
          {state === "off" ? (
            <button type="button" className="ui-button ui-button--primary ui-button--small" disabled={busy} onClick={() => void turnOn()} data-testid="settings-push-on">
              Ligar neste aparelho
            </button>
          ) : (
            <>
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void sendTest()} data-testid="settings-push-test">
                Mandar um aviso de teste
              </button>
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void turnOff()} data-testid="settings-push-off">
                Desligar neste aparelho
              </button>
            </>
          )}
        </div>
      )}
      {note && (
        <p className="settings__card-hint" role="status" data-testid="settings-push-note">
          {note}
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <div data-testid="settings-push-devices">
        <p className="settings__card-hint">Aparelhos inscritos{devices.length > 0 ? ` · ${devices.length}` : ""}</p>
        {devices.length === 0 ? (
          <p className="settings__card-hint">Nenhum aparelho ainda.</p>
        ) : (
          <ul className="settings__rows">
            {devices.map((device) => (
              <li key={device.id} className="settings__row" data-testid={`settings-push-device-${device.id}`}>
                <span className="settings__row-name">
                  {device.name} <small>· desde {dateLabel(device.createdAt)}</small>
                </span>
                <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void removeDevice(device.id)} aria-label={`Remover ${device.name}`}>
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
