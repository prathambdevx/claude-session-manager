// Lets a textarea accept a pasted image the way Claude Code's own CLI does: shows a clean
// "[Image N]" placeholder while typing, colored to stand out from the rest of the prompt, deleted
// as one atomic unit on backspace/delete — but the real prompt sent on submit has each placeholder
// swapped for its temp file path so Claude can Read it. One mechanism for every delivery path
// (fresh terminal, Quick Prompt terminal injection, Quick Prompt headless), since by the time the
// text leaves the browser it's just a plain string.
import { escapeHtml } from "./format.js";

const TOKEN_RE = /\[Image \d+\]/g;

// A plain <textarea> can't color part of its own text, so a same-metrics backdrop <div> sits
// behind it (transparent textarea background) with highlighted spans lined up under the matching
// characters — the real, editable text is still the native textarea rendering on top.
function mountHighlightBackdrop(textarea) {
  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  textarea.parentNode.insertBefore(wrap, textarea);
  wrap.appendChild(textarea);

  const backdrop = document.createElement("div");
  backdrop.className = "img-token-backdrop";
  wrap.insertBefore(backdrop, textarea);
  textarea.style.position = "relative";
  textarea.style.background = "transparent";

  const syncBoxStyle = () => {
    const cs = getComputedStyle(textarea);
    for (const prop of ["font", "letterSpacing", "padding", "border", "lineHeight", "boxSizing"]) {
      backdrop.style[prop] = cs[prop];
    }
    backdrop.style.width = textarea.offsetWidth + "px";
    backdrop.style.height = textarea.offsetHeight + "px";
  };
  syncBoxStyle();
  new ResizeObserver(syncBoxStyle).observe(textarea);

  const render = () => {
    backdrop.innerHTML = escapeHtml(textarea.value).replace(TOKEN_RE, (m) => `<span class="img-token">${m}</span>`);
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  };
  textarea.addEventListener("input", render);
  textarea.addEventListener("scroll", () => {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  });
  return render;
}

// Deletes a whole "[Image N]" token in one keystroke instead of eating it character by character.
function wireAtomicTokenDelete(textarea) {
  textarea.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace" && e.key !== "Delete") return;
    if (textarea.selectionStart !== textarea.selectionEnd) return;
    const pos = textarea.selectionStart;
    const value = textarea.value;
    if (e.key === "Backspace") {
      const before = value.slice(0, pos);
      const match = [...before.matchAll(TOKEN_RE)].pop();
      if (!match || match.index + match[0].length !== pos) return;
      e.preventDefault();
      textarea.setRangeText("", match.index, pos, "end");
    } else {
      const after = value.slice(pos);
      const match = after.match(TOKEN_RE);
      if (!match || match.index !== 0) return;
      e.preventDefault();
      textarea.setRangeText("", pos, pos + match[0].length, "start");
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Wires image-paste support onto a textarea; returns { resolvePromptText } to call before send. */
export function wireImagePaste(textarea) {
  const pathsByToken = new Map();
  let count = 0;
  const render = mountHighlightBackdrop(textarea);
  wireAtomicTokenDelete(textarea);

  textarea.addEventListener("paste", async (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const blob = item.getAsFile();
    if (!blob) return;

    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.readAsDataURL(blob);
    });

    count += 1;
    const token = `[Image ${count}]`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText(token, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    const res = await fetch("/api/paste-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mimeType: blob.type || "image/png", base64 }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (data?.path) pathsByToken.set(token, data.path);
  });

  render();

  function resolvePromptText(text) {
    let out = text;
    for (const [token, path] of pathsByToken) {
      // dropped tokens (user deleted the placeholder text) simply have nothing left to replace
      out = out.split(token).join(`[Image: ${path}]`);
    }
    return out;
  }

  return { resolvePromptText };
}
