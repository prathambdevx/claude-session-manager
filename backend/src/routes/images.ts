// Saves a pasted-image prompt attachment to a temp file so its absolute path can be embedded in
// plain prompt text and read by Claude's own Read tool — works uniformly across every delivery
// path (fresh terminal, Quick Prompt terminal injection, Quick Prompt headless) with no changes
// to any of them, since the image reference is just text by the time it reaches those.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "./json.ts";

const IMAGES_DIR = join(tmpdir(), "csm-quick-prompt-images");

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function handleImagesRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/paste-image" || req.method !== "POST") return null;

  const body = await req.json().catch(() => ({}));
  const mimeType = String(body?.mimeType ?? "");
  const base64 = String(body?.base64 ?? "");
  const ext = EXT_BY_MIME[mimeType];
  if (!ext || !base64) return json({ error: "unsupported or missing image data" }, { status: 400 });

  await mkdir(IMAGES_DIR, { recursive: true });
  const path = join(IMAGES_DIR, `${crypto.randomUUID()}.${ext}`);
  await Bun.write(path, Buffer.from(base64, "base64"));
  return json({ path });
}
