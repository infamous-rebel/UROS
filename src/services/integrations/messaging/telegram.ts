/**
 * Telegram messaging adapter (messaging:telegram) — INTERFACE-ONLY.
 * Per MASTER Rule 18 exception: awaiting a live provider contribution.
 * send() throws ProviderNotImplementedError (see interface_only.ts).
 */
import { makeInterfaceOnlyMessagingAdapter } from "./interface_only";

export const telegramAdapter = makeInterfaceOnlyMessagingAdapter("telegram");
