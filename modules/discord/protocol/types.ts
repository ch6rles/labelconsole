/**
 * The slice of Discord's interactions API this module uses (API v10).
 * https://docs.discord.com/developers/interactions/receiving-and-responding
 */
export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const MessageFlags = { EPHEMERAL: 1 << 6 } as const;
export const ComponentType = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, LABEL: 18 } as const;
export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, LINK: 5 } as const;
export const CommandType = { CHAT_INPUT: 1, MESSAGE: 3 } as const;
export const OptionType = { STRING: 3, BOOLEAN: 5 } as const;
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
  author?: { name: string; url?: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
};

export type Emoji = { name: string };
export type Button = { type: 2; style: 1 | 2 | 3 | 5; label: string; emoji?: Emoji; custom_id?: string; url?: string; disabled?: boolean };
export type StringSelect = { type: 3; custom_id: string; placeholder?: string; required?: boolean; options: Array<{ label: string; value: string; description?: string; emoji?: Emoji }> };
export type ActionRow = { type: 1; components: Array<Button | StringSelect> };
export type TextInput = { type: 4; custom_id: string; style: 1 | 2; required?: boolean; min_length?: number; max_length?: number; placeholder?: string; value?: string };
/** Modal layout: a label with a description wrapping one input. */
export type Label = { type: 18; label: string; description?: string; component: TextInput | StringSelect };

export type MessagePayload = {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  flags?: number;
  allowed_mentions?: { parse: string[] };
  /** Files sent with the message; referenced from embeds as `attachment://<name>`. */
  attachments?: Array<{ id: number; filename: string; description?: string }>;
};

/** A file to upload with an edit (chart image, audio preview). */
export type MessageFile = { name: string; contentType: string; data: Buffer; description?: string };

export type Modal = { custom_id: string; title: string; components: Label[] };

type MessageText = { content?: string; embeds?: Array<{ url?: string; title?: string; description?: string }> };
export type ResolvedMessage = MessageText & { id: string; message_snapshots?: Array<{ message?: MessageText }> };

/** A submitted modal field, in the current Label shape or the older action-row shape. */
export type ModalSubmitComponent = { type: number; custom_id?: string; value?: string; values?: string[]; component?: ModalSubmitComponent; components?: ModalSubmitComponent[] };

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
    /** Modal submits. */
    components?: ModalSubmitComponent[];
  };
  message?: { id: string; flags?: number };
};

export type InteractionResponse = { type: number; data?: MessagePayload | Modal | { choices: unknown[] } };
