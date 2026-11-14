// Barril do pacote (arquivo nosso, não vem do Habblaud): a única porta de entrada para o resto do Cyno.
// O motor de cena é o do Habblaud (MIT, ver LICENSE e ORIGEM.md); o que o Cyno altera está em PATCHES.md.
export { createWorld } from './client/src/world';
export type { WorldDebug, ExtraEntity, ExtraRect, ExtrasApi, FrameInfo, WorldProbe } from './client/src/world';
export type { AgentSocial, Selection, SocialEvent, SoundCue, WorldApi, WorldOptions, WorldPlayback } from './client/src/world/api';
export { OfficeStore, mockOptionsFrom } from './client/src/net/store';
export type { StoreOptions } from './client/src/net/store';
export { SoundBoard } from './client/src/audio/board';
export { NOME_DA_PLACA } from './client/src/world/constants';
// Tipos do retrato do escritório (só tipos: o adaptador do Cyno os usa sem puxar o motor).
export type { AppearanceParts } from './shared/appearance';
export type { AccountInfo, Activity, ActivityKind, AgentInfo, AgentStatus, OfficeSnapshot, RoomEffect, RoomInfo, ShellJob, TaskItem } from './shared/types';
