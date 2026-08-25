// Pure rules for the media on an incoming status (#2952). Kept out of
// `index.ts` because that module reads env and calls `process.exit` at
// import time, so it cannot be pulled into a test.

import { isRecord } from "@mulmoclaude/common";

/** A media entry the bridge forwards. Mastodon also carries `video`,
 *  `gifv`, `audio` and `unknown` types; those are left alone. */
export interface ImageMedia {
  url: string;
}

/** chat-service rejects an empty `text`, so an attachment-only status
 *  needs a body. Same wording as the Telegram, LINE and Discord
 *  bridges — an instruction, so the agent treats the image as the
 *  subject rather than looking for a caption. */
const ATTACHMENT_ONLY_PROMPT = "Describe / analyze this file.";

/** The image entries of a status' `media_attachments`, in order. */
export function imageMediaEntries(media: unknown): ImageMedia[] {
  if (!Array.isArray(media)) return [];
  return media.flatMap((item) => (isRecord(item) && item.type === "image" && typeof item.url === "string" ? [{ url: item.url }] : []));
}

/** False when there is nothing to relay at all — no caption, and no
 *  images to stand in for one. */
export function hasRelayableContent(text: string, mediaCount: number): boolean {
  return text.trim().length > 0 || mediaCount > 0;
}

/** True when a status that DID carry images ends up with none of them
 *  and no caption to fall back on. Only meaningful once
 *  `hasRelayableContent` has already passed. */
export function isLostImagesOnly(text: string, attachmentCount: number): boolean {
  return text.trim().length === 0 && attachmentCount === 0;
}

/** The body sent to MulmoClaude: a placeholder when the sender posted
 *  only images, plus a note when some of them were lost. */
export function resolveMessageText(text: string, dropped: number): string {
  const trimmed = text.trim();
  const body = trimmed.length > 0 ? trimmed : ATTACHMENT_ONLY_PROMPT;
  if (dropped <= 0) return body;
  const plural = dropped === 1 ? "file" : "files";
  return `${body}\n\n(note: ${dropped} attached ${plural} could not be downloaded)`;
}
