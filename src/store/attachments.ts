import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { redactLogText } from "../platform/adapter.js";
import { newId } from "../util.js";

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  /** Absolute local path inside `<TIMO_HOME>/attachments/` so CLI executors can read/inspect directly. */
  filePath: string;
  /** Loopback API path for rendering thumbnails or downloading in the Web UI. */
  url: string;
}

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MiB per file
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

const SAFE_ID_RE = /^[a-z0-9-]+$/i;
const INLINE_IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif)$/i;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

/**
 * Local attachment store under `<TIMO_HOME>/attachments/` (0700 dir, 0600 files).
 * Keeps user-uploaded screenshots and files outside Git repositories while
 * giving local CLI executors (Qwen Code / Pi / Codex / OpenCode) direct
 * read-only file paths they can inspect with native vision or file-read tools.
 */
export class AttachmentStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = resolve(home, "attachments");
  }

  saveBase64(input: { name?: string; mimeType?: string; dataBase64: string }): ChatAttachment {
    const rawBase64 = input.dataBase64.trim().replace(/^data:[^;]+;base64,/i, "");
    if (!rawBase64) throw new Error("attachment data is empty");
    const bytes = Buffer.from(rawBase64, "base64");
    if (bytes.byteLength === 0) throw new Error("attachment data is empty");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment exceeds ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB limit`);
    }

    const mimeType = normalizeMime(input.mimeType);
    const isImage = INLINE_IMAGE_MIME_RE.test(mimeType);
    const name = sanitizeFileName(input.name, mimeType);
    const ext = pickSafeExtension(name, mimeType);
    const id = newId();

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const filePath = resolve(this.dir, `${id}${ext}`);
    const metaPath = resolve(this.dir, `${id}.meta.json`);
    if (!filePath.startsWith(`${this.dir}${sep}`) || !metaPath.startsWith(`${this.dir}${sep}`)) {
      throw new Error("invalid attachment path");
    }

    writeFileSync(filePath, bytes, { mode: 0o600 });
    const record: ChatAttachment = {
      id,
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
      isImage,
      filePath,
      url: `/api/attachments/${id}`,
    };
    writeFileSync(metaPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return record;
  }

  get(id: string): ChatAttachment | null {
    const clean = id.trim();
    if (!SAFE_ID_RE.test(clean)) return null;
    const metaPath = resolve(this.dir, `${clean}.meta.json`);
    if (!metaPath.startsWith(`${this.dir}${sep}`) || !existsSync(metaPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as ChatAttachment;
      const resolvedFile = resolve(parsed.filePath);
      if (!resolvedFile.startsWith(`${this.dir}${sep}`) || !existsSync(resolvedFile)) return null;
      return { ...parsed, filePath: resolvedFile };
    } catch {
      return null;
    }
  }

  readBytes(id: string): { attachment: ChatAttachment; bytes: Buffer } | null {
    const attachment = this.get(id);
    if (!attachment) return null;
    try {
      return { attachment, bytes: readFileSync(attachment.filePath) };
    } catch {
      return null;
    }
  }

  delete(id: string): boolean {
    const attachment = this.get(id);
    if (!attachment) return false;
    const metaPath = resolve(this.dir, `${attachment.id}.meta.json`);
    try {
      if (existsSync(attachment.filePath)) rmSync(attachment.filePath, { force: true });
      if (existsSync(metaPath)) rmSync(metaPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns a redacted inline text preview for small UTF-8 text/code/log files
   * so text-focused executors can inspect attached logs/configs without extra tool calls.
   */
  readTextPreview(attachment: ChatAttachment, maxChars = 6000): { text: string; truncated: boolean } | null {
    if (attachment.isImage || attachment.sizeBytes > 64 * 1024) return null;
    if (!existsSync(attachment.filePath)) return null;
    try {
      const bytes = readFileSync(attachment.filePath);
      const raw = bytes.toString("utf8");
      const isUtf8 = !raw.includes("\uFFFD") && Buffer.from(raw, "utf8").equals(bytes);
      if (!isUtf8) return null;
      const safe = redactLogText(raw).text;
      if (safe.length <= maxChars) return { text: safe, truncated: false };
      return { text: `${safe.slice(0, maxChars)}\n…（后续内容请直接读取原文件）`, truncated: true };
    } catch {
      return null;
    }
  }
}

function normalizeMime(raw?: string): string {
  const clean = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (clean && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(clean)) return clean;
  return "application/octet-stream";
}

function sanitizeFileName(raw: string | undefined, mimeType: string): string {
  const base = basename((raw ?? "").replace(/\\/g, "/"))
    .replace(/[\r\n\t\0]/g, "")
    .trim();
  if (base && base !== "." && base !== "..") {
    return base.slice(0, 140);
  }
  const ext = MIME_TO_EXT[mimeType] ?? ".bin";
  return `attachment-${Date.now()}${ext}`;
}

function pickSafeExtension(fileName: string, mimeType: string): string {
  const fromName = extname(fileName).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(fromName)) return fromName;
  return MIME_TO_EXT[mimeType] ?? ".bin";
}
