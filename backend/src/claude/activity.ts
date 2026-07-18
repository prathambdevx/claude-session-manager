// Turns a stream-json/transcript event into a short human-readable activity line, or null. Shared
// by detachedRunner.ts and sessions.ts.
// Full absolute paths (/Users/x/Desktop/project/deeply/nested/file.tsx) are noise on a small chip
// — parent-dir/filename is enough to recognize what's being touched without needing the whole route.
function shortenPath(p: string): string {
  const parts = String(p).split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
}

// A Bash command's arguments are often full paths too ("rm /Users/x/Desktop/proj/deep/file.tsx") —
// shorten any path-shaped token found anywhere in the command string, not just a dedicated
// file_path input. Requires 3+ path segments so short things like "/tmp/x" are left alone. Only
// applied to Bash commands — NOT to url/query/pattern, since those aren't filesystem paths (a URL's
// domain matters more than its trailing segments, unlike a noisy /Users/name/... home-dir prefix).
function shortenPathsInText(text: string): string {
  return text.replace(/(?:\/[^\s'"]+){3,}/g, (m) => shortenPath(m));
}

export function activityLine(d: any): string | null {
  if (d?.type === "system" && d?.subtype === "init") return "▸ starting up…";
  if (d?.type === "assistant" && Array.isArray(d?.message?.content)) {
    for (const b of d.message.content) {
      if (b?.type === "tool_use") {
        const inp = b.input || {};
        const path = inp.file_path || inp.notebook_path;
        const detail = path ? shortenPath(path)
          : inp.command ? shortenPathsInText(inp.command)
          : inp.pattern || inp.url || inp.query || "";
        return `🔧 ${b.name}${detail ? `: ${String(detail).slice(0, 80)}` : ""}`;
      }
      if (b?.type === "text" && b.text?.trim()) {
        return `💭 ${b.text.trim().replace(/\s+/g, " ").slice(0, 100)}`;
      }
      if (b?.type === "thinking" && b.thinking?.trim()) {
        return `🤔 ${b.thinking.trim().replace(/\s+/g, " ").slice(0, 100)}`;
      }
    }
  }
  return null;
}
