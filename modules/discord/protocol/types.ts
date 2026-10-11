/**
 * The slice of Discord's interactions API this module uses (API v10).
 * https://discord.com/developers/docs/interactions/receiving-and-responding
 */
export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE_RESULT: 8,
} as const;

export const MessageFlags = { EPHEMERAL: 1 << 6 } as const;
export const ComponentType = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3 } as const;
export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, LINK: 5 } as const;
export const CommandType = { CHAT_INPUT: 1, MESSAGE: 3 } as const;
export const OptionType = { STRING: 3 } as const;
/** Where an app can be installed: to a server, or to a person's account (usable anywhere they are). */
export const IntegrationType = { GUILD_INSTALL: 0, USER_INSTALL: 1 } as const;
/** Where a command can be used: servers, DMs with the app, group DMs and other DMs. */
export const ContextType = { GUILD: 0, BOT_DM: 1, PRIVATE_CHANNEL: 2 } as const;

export type DiscordUser = { id: string; username: string; global_name?: string | null };

export type Embed = {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string };
  thumbnail?: { url: string };
  footer?: { text: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
};

export type Button = { type: 2; style: 1 | 2 | 5; label: string; custom_id?: string; url?: string; disabled?: boolean };
export type StringSelect = { type: 3; custom_id: string; placeholder?: string; options: Array<{ label: string; value: string; description?: string }> };
export type ActionRow = { type: 1; components: Array<Button | StringSelect> };

export type MessagePayload = {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  flags?: number;
  allowed_mentions?: { parse: string[] };
};

export type Interaction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  version?: number;
  guild_id?: string;
  channel_id?: string;
  /** In servers the invoking user is under `member`; in DMs it is `user`. */
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    type?: number;
    options?: Array<{ name: string; type: number; value?: string | number | boolean }>;
    target_id?: string;
    resolved?: { messages?: Record<string, ResolvedMessage> };
    custom_id?: string;
    component_type?: number;
    values?: string[];
  };
  message?: { id: string; flags?: number };
};

type MessageText = { content?: string; embeds?: Array<{ url?: string; title?: string; description?: string }> };
export type ResolvedMessage = MessageText & { id: string; message_snapshots?: Array<{ message?: MessageText }> };

export type InteractionResponse = { type: number; data?: MessagePayload | { choices: unknown[] } };
