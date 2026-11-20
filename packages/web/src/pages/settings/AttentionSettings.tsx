import { ATTENTION_KIND_LABELS, type AttentionKind } from "@cyno/shared";
import { useState } from "react";
import { useDevicePrefs } from "../../attention/devicePrefs";
import { notificationPermission, requestNotificationPermission, type NotificationPermissionState } from "../../attention/notify";
import { attentionAudio } from "../../attention/sound";
import { clockLabel, dndChoice, dndText, muteState, SILENCE_CHOICES, withMute, type SilenceChoice } from "../../attention/settingsModel";
import { describeError } from "../../api/client";
import { useAttentionStore } from "../../store/attentionStore";
import { useNow } from "../../ui/ActivityFeed";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { ErrorText } from "../../ui/widgets";
import { PushSettings } from "./PushSettings";
import { OptionHead, SettingSwitch, StateBadge } from "./SettingsOption";
import "../../hud/attention.css";

/** Os tipos que o dono liga e desliga (o orçamento tem aviso próprio). */
const KIND_ROWS: { kind: AttentionKind; title: string; line: string }[] = [
  { kind: "approval", title: ATTENTION_KIND_LABELS.approval, line: "Um agente pediu o seu OK em Aprovações." },
  { kind: "question", title: ATTENTION_KIND_LABELS.question, line: "Um agente fez uma pergunta que só você responde." },
  { kind: "plan", title: ATTENTION_KIND_LABELS.plan, line: "Um plano espera o seu OK para começar." },
  { kind: "sprint", title: ATTENTION_KIND_LABELS.sprint, line: "Uma sprint terminou e espera a sua conferência." },
  { kind: "routine", title: ATTENTION_KIND_LABELS.routine, line: "Uma proposta de rotina espera o seu OK." },
  { kind: "help", title: ATTENTION_KIND_LABELS.help, line: "Pedido de acesso ou ajuda que o Maestro não resolveu em 5 minutos." },
  { kind: "failed", title: ATTENTION_KIND_LABELS.failed, line: "Uma tarefa falhou." },
  { kind: "blocked", title: ATTENTION_KIND_LABELS.blocked, line: "Uma tarefa travou porque a que ela espera falhou ou foi cancelada." },
  { kind: "engine_down", title: ATTENTION_KIND_LABELS.engine_down, line: "O terminal de um agente caiu e não voltou." },
  { kind: "usage", title: ATTENTION_KIND_LABELS.usage, line: "A assinatura chegou a 80%, a 95% ou esgotou. Só avisa." },
  { kind: "delivery", title: ATTENTION_KIND_LABELS.delivery, line: "Um pedido seu foi entregue. Vem desligado." },
];

const PERMISSION_TEXT: Record<NotificationPermissionState, { tone: "on" | "off" | "warn" | "value"; text: string; hint?: string }> = {
  granted: { tone: "on", text: "Permitida" },
  default: { tone: "value", text: "Ainda não pedida" },
  denied: { tone: "warn", text: "Bloqueada", hint: "Libere nas configurações do site (o cadeado ao lado do endereço) e volte aqui." },
  unsupported: { tone: "off", text: "Sem suporte", hint: "Este navegador não mostra notificações." },
};

/**
 * Seção "Avisos": como o Cyno chama você quando um agente precisa de você. O som, a notificação do
 * navegador e o aviso na tela valem só neste aparelho; os tipos, os workspaces silenciados e o "não
 * perturbe" são da conta (valem em todos os aparelhos). O alerta continua contando no número e no
 * sino mesmo quando o aviso está silenciado.
 */
export function AttentionSettings() {
  const device = useDevicePrefs((state) => state.prefs);
  const setDevice = useDevicePrefs((state) => state.set);
  const account = useAttentionStore((state) => state.prefs);
  const savePrefs = useAttentionStore((state) => state.savePrefs);
  const workspaces = useWorkspaceStore((state) => state.workspaces) ?? [];
  const [permission, setPermission] = useState<NotificationPermissionState>(() => notificationPermission());
  const [error, setError] = useState<string | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);

  const save = async (body: Parameters<typeof savePrefs>[0]) => {
    setError(null);
    try {
      await savePrefs(body);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const playSample = async (volume: number) => {
    if (await attentionAudio.unlock()) attentionAudio.play("chime", volume);
  };

  const toggleSound = async (on: boolean) => {
    setDevice({ sound: on });
    // Ligar é um clique do dono: o navegador libera o áudio e toca uma amostra para ele ouvir.
    if (on) await playSample(device.volume);
  };

  const toggleNotifications = async (on: boolean) => {
    if (!on) {
      setDevice({ browserNotifications: false });
      return;
    }
    const next = await requestNotificationPermission();
    setPermission(next);
    setDevice({ browserNotifications: next === "granted" });
  };

  const now = useNow().getTime();
  const volume = volumeDraft ?? device.volume;
  const permissionInfo = PERMISSION_TEXT[permission];

  return (
    <div className="settings__groups" data-testid="settings-attention">
      <section className="settings__card" data-testid="settings-attention-toasts">
        <SettingSwitch
          title="Aviso na tela"
          seal="navegador"
          line="Um aviso com o botão “Responder”, em qualquer página. Ele só leva até o item e nunca aprova nada."
          checked={device.toasts}
          onToggle={async (on) => setDevice({ toasts: on })}
          testId="settings-attn-toasts"
        />
      </section>

      <section className="settings__card" data-testid="settings-attention-sound">
        <SettingSwitch
          title="Som dos avisos"
          seal="navegador"
          line="Um sino curto quando algo espera você, mesmo com a aba escondida."
          checked={device.sound}
          onToggle={toggleSound}
          testId="settings-attn-sound"
        />
        <details className="settings__more">
          <summary>Por que vem desligado</summary>
          <p>O navegador só libera o som depois de um clique seu. Ao ligar, toca uma amostra.</p>
        </details>
        <div className="settings__switches">
          <label className="settings__field">
            <span>Volume · {volume}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={volume}
              disabled={!device.sound}
              aria-label="Volume dos avisos"
              onChange={(event) => setVolumeDraft(Number(event.currentTarget.value))}
              onPointerUp={() => {
                if (volumeDraft === null) return;
                setDevice({ volume: volumeDraft });
                void playSample(volumeDraft);
                setVolumeDraft(null);
              }}
              onKeyUp={() => {
                if (volumeDraft === null) return;
                setDevice({ volume: volumeDraft });
                void playSample(volumeDraft);
                setVolumeDraft(null);
              }}
              data-testid="settings-attn-volume"
            />
          </label>
          <SettingSwitch title="Quando algo espera você" seal="navegador" line="Aprovação, pergunta, plano, ajuda e terminal que caiu." checked={device.soundKinds.pedidos} disabled={!device.sound} onToggle={async (on) => setDevice({ soundKinds: { pedidos: on } })} testId="settings-attn-sound-pedidos" />
          <SettingSwitch title="Quando uma tarefa falha" seal="navegador" line="Um som mais baixo e curto, diferente do sino." checked={device.soundKinds.falhas} disabled={!device.sound} onToggle={async (on) => setDevice({ soundKinds: { falhas: on } })} testId="settings-attn-sound-falhas" />
          <SettingSwitch title="Limite de uso e outros avisos" seal="navegador" line="80%, 95% e esgotado da assinatura." checked={device.soundKinds.informativos} disabled={!device.sound} onToggle={async (on) => setDevice({ soundKinds: { informativos: on } })} testId="settings-attn-sound-info" />
        </div>
      </section>

      <section className="settings__card" data-testid="settings-attention-notify">
        <SettingSwitch
          title="Notificação do navegador"
          seal="navegador"
          line="Com a aba escondida, o navegador notifica e, ao clicar, o Cyno abre o item."
          checked={device.browserNotifications && permission === "granted"}
          disabled={permission === "unsupported"}
          onToggle={toggleNotifications}
          testId="settings-attn-notify"
        />
        <p className="settings__card-hint" data-testid="settings-attn-permission">
          Permissão: <StateBadge tone={permissionInfo.tone}>{permissionInfo.text}</StateBadge>
        </p>
        {permissionInfo.hint && (
          <details className="settings__more">
            <summary>{permission === "denied" ? "Como liberar no navegador" : "Saiba mais"}</summary>
            <p>{permissionInfo.hint}</p>
          </details>
        )}
        <details className="settings__more">
          <summary>No celular</summary>
          <p>Funciona com o site aberto em segundo plano. Para avisar com o site fechado, use o cartão abaixo.</p>
        </details>
      </section>

      <PushSettings />

      <section className="settings__card" data-testid="settings-attention-kinds">
        <OptionHead title="O que avisa" seal="plataforma" line="Desligar um tipo tira aviso, som e notificação. O sino continua contando." />
        <details className="settings__more">
          <summary>Como cada tipo se comporta</summary>
          <p>Tarefa que falhou toca um som discreto, se o som estiver ligado. Tarefa travada pode ser refeita, ficar sem a dependência ou ser cancelada. Pedido entregue fica só no sino, sem som e sem contar em “Esperando você”; ligue para avisar também na tela.</p>
        </details>
        <div className="settings__switches">
          {KIND_ROWS.map((row) => (
            <SettingSwitch key={row.kind} title={row.title} seal="plataforma" line={row.line} checked={row.kind === "delivery" ? account.kinds.delivery === true : account.kinds[row.kind] !== false} onToggle={(on) => save({ kinds: { ...account.kinds, [row.kind]: on } })} testId={`settings-attn-kind-${row.kind}`} />
          ))}
        </div>
      </section>

      <section className="settings__card" data-testid="settings-attention-mute">
        <OptionHead title="Silenciar um workspace" seal="plataforma" line="Sem aviso, som nem notificação dele pelo tempo escolhido. Os alertas continuam contando." />
        {workspaces.length === 0 ? (
          <p className="settings__card-hint">Ainda não há workspace.</p>
        ) : (
          <ul className="settings__rows">
            {workspaces.map((ws) => {
              const state = muteState(account, ws.id, now);
              return (
                <li key={ws.id} className="settings__row">
                  <span className="settings__row-name">{ws.name}</span>
                  {state.state === "until" && state.until && <StateBadge tone="warn">Silenciado até {clockLabel(state.until, now)}</StateBadge>}
                  {state.state === "always" && <StateBadge tone="warn">Silenciado</StateBadge>}
                  <select
                    className="ui-input ui-input--compact"
                    aria-label={`Avisos de ${ws.name}`}
                    value={state.state === "off" ? "off" : state.state === "always" ? "always" : "keep"}
                    onChange={(event) => {
                      const choice = event.currentTarget.value as SilenceChoice | "keep";
                      if (choice !== "keep") void save({ mutedWorkspaces: withMute(account.mutedWorkspaces, ws.id, choice, Date.now()) });
                    }}
                    data-testid={`settings-attn-mute-${ws.id}`}
                  >
                    {state.state === "until" && <option value="keep">Em silêncio</option>}
                    {SILENCE_CHOICES.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="settings__card" data-testid="settings-attention-dnd">
        <OptionHead title="Não perturbe" seal="plataforma" line="Pausa todos os avisos por um tempo, em todos os aparelhos." state={<StateBadge tone={account.dndUntil && Date.parse(account.dndUntil) > now ? "warn" : "off"}>{dndText(account, now, (iso) => clockLabel(iso, now))}</StateBadge>} />
        <div className="settings__actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void save({ dndUntil: dndChoice("1h", Date.now()) })} data-testid="settings-attn-dnd-1h">
            Por 1 hora
          </button>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void save({ dndUntil: dndChoice("tomorrow", Date.now()) })} data-testid="settings-attn-dnd-tomorrow">
            Até amanhã
          </button>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void save({ dndUntil: dndChoice("off", Date.now()) })} data-testid="settings-attn-dnd-off">
            Desligar
          </button>
        </div>
      </section>

      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
