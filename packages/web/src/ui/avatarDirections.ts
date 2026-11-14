/** Direções do personagem no editor de avatar: SE/SW = de frente (3/4), NE/NW = de costas. */
export const AVATAR_DIRECTIONS = ["SE", "SW", "NE", "NW"] as const;
export type AvatarDirection = (typeof AVATAR_DIRECTIONS)[number];
