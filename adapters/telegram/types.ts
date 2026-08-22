/**
 * Minimal Telegram Bot API shapes used by Delos, with explicit type
 * guards. All external JSON is narrowed here; nothing downstream
 * touches unvalidated `any`.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  /** Unix timestamp (seconds) supplied by Telegram, when present. */
  date?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  reply_to_message?: TelegramMessage;
}

/** Inline-button press. `data` is our own opaque nonce token, never text. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  /** Message the button was attached to (chat needed for auth checks). */
  message?: { message_id: number; chat: TelegramChat };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  /** True when the update carried a non-message payload we ignore. */
  hasOtherPayload: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asUser(value: unknown): TelegramUser | undefined {
  if (!isRecord(value) || typeof value.id !== "number") {
    return undefined;
  }
  return {
    id: value.id,
    is_bot: value.is_bot === true,
    ...(typeof value.username === "string" ? { username: value.username } : {}),
  };
}

function asPhotoSizes(value: unknown): TelegramPhotoSize[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sizes: TelegramPhotoSize[] = [];
  for (const item of value) {
    if (
      isRecord(item) &&
      typeof item.file_id === "string" &&
      typeof item.width === "number" &&
      typeof item.height === "number"
    ) {
      sizes.push({
        file_id: item.file_id,
        width: item.width,
        height: item.height,
        ...(typeof item.file_unique_id === "string"
          ? { file_unique_id: item.file_unique_id }
          : {}),
        ...(typeof item.file_size === "number" ? { file_size: item.file_size } : {}),
      });
    }
  }
  return sizes.length > 0 ? sizes : undefined;
}

function asVoice(value: unknown): TelegramVoice | undefined {
  if (!isRecord(value) || typeof value.file_id !== "string") {
    return undefined;
  }
  return {
    file_id: value.file_id,
    ...(typeof value.file_unique_id === "string"
      ? { file_unique_id: value.file_unique_id }
      : {}),
    ...(typeof value.duration === "number" ? { duration: value.duration } : {}),
    ...(typeof value.mime_type === "string" ? { mime_type: value.mime_type } : {}),
    ...(typeof value.file_size === "number" ? { file_size: value.file_size } : {}),
  };
}

export function asMessage(value: unknown): TelegramMessage | undefined {
  if (!isRecord(value) || typeof value.message_id !== "number") {
    return undefined;
  }
  const chat = value.chat;
  if (!isRecord(chat) || typeof chat.id !== "number" || typeof chat.type !== "string") {
    return undefined;
  }
  const reply =
    value.reply_to_message !== undefined ? asMessage(value.reply_to_message) : undefined;
  return {
    message_id: value.message_id,
    chat: { id: chat.id, type: chat.type },
    ...(typeof value.date === "number" && Number.isFinite(value.date)
      ? { date: value.date }
      : {}),
    ...(asUser(value.from) ? { from: asUser(value.from) } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.caption === "string" ? { caption: value.caption } : {}),
    ...(asPhotoSizes(value.photo) ? { photo: asPhotoSizes(value.photo) } : {}),
    ...(asVoice(value.voice) ? { voice: asVoice(value.voice) } : {}),
    ...(reply ? { reply_to_message: reply } : {}),
  };
}

function asCallbackQuery(value: unknown): TelegramCallbackQuery | undefined {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }
  const from = asUser(value.from);
  if (from === undefined) {
    return undefined;
  }
  let message: TelegramCallbackQuery["message"];
  if (isRecord(value.message) && typeof value.message.message_id === "number") {
    const chat = value.message.chat;
    if (isRecord(chat) && typeof chat.id === "number" && typeof chat.type === "string") {
      message = { message_id: value.message.message_id, chat: { id: chat.id, type: chat.type } };
    }
  }
  return {
    id: value.id,
    from,
    ...(message !== undefined ? { message } : {}),
    ...(typeof value.data === "string" ? { data: value.data } : {}),
  };
}

/** Narrow one getUpdates entry. Returns null when update_id is absent. */
export function asUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value) || typeof value.update_id !== "number") {
    return null;
  }
  const message = asMessage(value.message);
  const callbackQuery = asCallbackQuery(value.callback_query);
  const otherKeys = Object.keys(value).filter(
    (k) => k !== "update_id" && k !== "message" && k !== "callback_query",
  );
  return {
    update_id: value.update_id,
    ...(message ? { message } : {}),
    ...(callbackQuery ? { callback_query: callbackQuery } : {}),
    hasOtherPayload: otherKeys.length > 0,
  };
}
