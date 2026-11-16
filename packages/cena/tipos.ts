// Só os tipos do retrato do escritório (arquivo nosso, sem código nem DOM): quem monta o retrato fora do navegador
// (o adaptador em `@cyno/shared/cena`, que o servidor também usa) importa daqui, sem puxar o motor inteiro.
export type { AppearanceParts } from './shared/appearance';
export type { AccountInfo, Activity, ActivityKind, AgentInfo, AgentStatus, OfficeSnapshot, RoomEffect, RoomInfo, ShellJob, TaskItem } from './shared/types';
