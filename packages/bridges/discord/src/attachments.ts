// Attachment handling for the Discord bridge (#2939). Kept out of
// `index.ts` so the download rules can be exercised with a stubbed
// fetch — no gateway, no CDN, no env reads.

import { mimeFromExtension } from "@mulmobridge/client";
import type { Attachment } from "@mulmobridge/protocol";

/** The fields of discord.js' `Attachment` this bridge reads. */
export interface DiscordAttachmentLike {
  url: string;
  name: string;
  size: number;
  contentType: string | null;
}

export interface CollectedAttachments {
  attachments: Attachment[];
  /** Attachments on the message that could not be forwarded — over the
   *  cap, past the count limit, or the download failed. */
  dropped: number;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface DownloadDeps {
  fetchFn: FetchFn;
  log?: { warn: (message: string) => void };
}

// Discord serves message attachments from its own CDN. A URL pointing
// anywhere else means the payload was tampered with, so it is refused
// rather than turned into a server-side request forgery primitive.
const ALLOWED_HOST_SUFFIXES = [".discordapp.com", ".discordapp.net", ".discord.com"];

/** Per-file byte cap. chat-service's own gate is 20 MB of base64
 *  across the whole message (~15 MB raw), so one file stays well
 *  under it. Discord's free-tier upload limit is 10 MB. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** chat-service's `parseAttachments` drops everything past the tenth
 *  entry, so downloading more than that is wasted bandwidth. */
export const MAX_ATTACHMENT_COUNT = 10;
const FETCH_TIMEOUT_MS = 30_000;
const FALLBACK_MIME = "application/octet-stream";
/** chat-service rejects an empty `text`, so an attachment-only message
 *  needs a body. Same wording as the Telegram and LINE bridges — an
 *  instruction, so the agent treats the file as the subject. */
const ATTACHMENT_ONLY_PROMPT = "Describe / analyze this file.";
const LOG_LABEL_MAX_CHARS = 100;
const UNPRINTABLE_RE = /[^\p{L}\p{N}\p{P}\p{S}\p{Zs}]/gu;

const defaultLog = { warn: (message: string) => console.warn(message) };

export function isDiscordCdnUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (url === null || url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Discord's `contentType` carries parameters (`text/plain; charset=utf-8`)
 *  and is null for types it cannot sniff, so fall back to the filename. */
export function resolveMimeType(file: DiscordAttachmentLike): string {
  const declared = (file.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared.length > 0) return declared;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0 || dot === file.name.length - 1) return FALLBACK_MIME;
  return mimeFromExtension(file.name.slice(dot + 1), FALLBACK_MIME);
}

/** Why this file cannot be fetched at all, or null when it may be. */
function refuseReason(file: DiscordAttachmentLike): string | null {
  if (!isDiscordCdnUrl(file.url)) return "not served from a Discord CDN host";
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.size} bytes is over the ${MAX_ATTACHMENT_BYTES} byte cap`;
  return null;
}

/** A filename reaches the log verbatim; control characters in it would
 *  forge log lines, so keep only printable categories. */
function logLabel(name: string): string {
  return name.replace(UNPRINTABLE_RE, " ").slice(0, LOG_LABEL_MAX_CHARS);
}

async function drainCapped(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/** Read at most `maxBytes`, aborting mid-stream rather than after the
 *  fact — `arrayBuffer()` would have already materialised the body. */
async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const { body } = res;
  if (body === null) return null;
  return drainCapped(body.getReader(), maxBytes);
}

export async function downloadAttachment(file: DiscordAttachmentLike, deps: DownloadDeps): Promise<Attachment | null> {
  const log = deps.log ?? defaultLog;
  const refused = refuseReason(file);
  if (refused !== null) {
    log.warn(`[discord] attachment skipped: ${logLabel(file.name)} — ${refused}`);
    return null;
  }
  try {
    const res = await deps.fetchFn(file.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) {
      log.warn(`[discord] attachment fetch failed: ${logLabel(file.name)} — HTTP ${res.status}`);
      return null;
    }
    const bytes = await readCappedBody(res, MAX_ATTACHMENT_BYTES);
    if (bytes === null) {
      log.warn(`[discord] attachment skipped: ${logLabel(file.name)} — body over the ${MAX_ATTACHMENT_BYTES} byte cap`);
      return null;
    }
    return { mimeType: resolveMimeType(file), data: bytes.toString("base64"), filename: file.name };
  } catch (err) {
    log.warn(`[discord] attachment download failed: ${logLabel(file.name)} — ${err}`);
    return null;
  }
}

export async function collectAttachments(files: DiscordAttachmentLike[], deps: DownloadDeps): Promise<CollectedAttachments> {
  const considered = files.slice(0, MAX_ATTACHMENT_COUNT);
  const results = await Promise.all(considered.map((file) => downloadAttachment(file, deps)));
  const attachments = results.filter((entry): entry is Attachment => entry !== null);
  return { attachments, dropped: files.length - attachments.length };
}

/** The body sent to MulmoClaude: a placeholder when the user posted
 *  only files, plus a note when some of them were lost. */
export function resolveMessageText(text: string, dropped: number): string {
  const trimmed = text.trim();
  const body = trimmed.length > 0 ? trimmed : ATTACHMENT_ONLY_PROMPT;
  if (dropped <= 0) return body;
  const plural = dropped === 1 ? "file" : "files";
  return `${body}\n\n(note: ${dropped} attached ${plural} could not be downloaded)`;
}
