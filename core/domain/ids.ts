/**
 * Canonical Delos-owned identifier types: the single definition site for
 * every ID the memory domain persists. Branded values assign freely TO
 * plain string, so existing string-typed runtime signatures stay
 * untouched; plain string becomes a branded ID only through the checked
 * constructors below. Nothing here may reference a transport, provider,
 * or backend: Telegram IDs, provider thread/session IDs, vendor request
 * IDs, and KiwiMem IDs are never canonical identity.
 */

type Brand<T extends string> = string & { readonly __delosBrand: T };

/** UUID-backed canonical IDs (Delos-minted, `crypto.randomUUID` shaped). */
export type ConversationId = Brand<"ConversationId">;
export type TurnId = Brand<"TurnId">;
export type MessageId = Brand<"MessageId">;
export type MemoryId = Brand<"MemoryId">;
export type RevisionId = Brand<"RevisionId">;
export type MemoryEventId = Brand<"MemoryEventId">;
export type ImportId = Brand<"ImportId">;
export type ManualEntryId = Brand<"ManualEntryId">;

/**
 * Slug-backed canonical keys. ModelFamilyId names a Delos assistant
 * family ("gpt", "claude", a future family) — never a provider API name,
 * exact model version, vendor account, or transport. AssistantInstanceId
 * names a stable Delos persona/runtime instance ("companion") — never a
 * process ID, CLI session, provider thread, vendor request, or Telegram
 * identifier. No family enum exists anywhere; a new family is a new slug.
 */
export type ModelFamilyId = Brand<"ModelFamilyId">;
export type AssistantInstanceId = Brand<"AssistantInstanceId">;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELOS_SLUG = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Canonical UUID: LOWERCASE hyphenated RFC 4122 form only (exactly what
 * crypto.randomUUID emits). One identity has exactly one textual form, so
 * case variants can never bypass duplicate or reference checks.
 */
export const isCanonicalUuid = (value: string): boolean => CANONICAL_UUID.test(value);

/** Lowercase slug: starts with a letter, digits/hyphens allowed, ≤32 chars. */
export const isDelosSlug = (value: string): boolean => DELOS_SLUG.test(value);

function checkedUuid<T>(idName: string, value: string): T {
  if (!isCanonicalUuid(value)) {
    throw new Error(`${idName} must be a canonical lowercase hyphenated UUID, got "${value}"`);
  }
  return value as T;
}

function checkedSlug<T>(idName: string, value: string): T {
  if (!isDelosSlug(value)) {
    throw new Error(
      `${idName} must be a lowercase slug matching ^[a-z][a-z0-9-]{0,31}$, got "${value}"`,
    );
  }
  return value as T;
}

export const asConversationId = (value: string): ConversationId =>
  checkedUuid("ConversationId", value);
export const asTurnId = (value: string): TurnId => checkedUuid("TurnId", value);
export const asMessageId = (value: string): MessageId => checkedUuid("MessageId", value);
export const asMemoryId = (value: string): MemoryId => checkedUuid("MemoryId", value);
export const asRevisionId = (value: string): RevisionId => checkedUuid("RevisionId", value);
export const asMemoryEventId = (value: string): MemoryEventId =>
  checkedUuid("MemoryEventId", value);
export const asImportId = (value: string): ImportId => checkedUuid("ImportId", value);
export const asManualEntryId = (value: string): ManualEntryId =>
  checkedUuid("ManualEntryId", value);
export const asModelFamilyId = (value: string): ModelFamilyId =>
  checkedSlug("ModelFamilyId", value);
export const asAssistantInstanceId = (value: string): AssistantInstanceId =>
  checkedSlug("AssistantInstanceId", value);
