// Shared form-control fragments so every modal renders the same model dropdown + dangerous toggle
// (change once here, all modals update). Each takes the element id the modal reads back from.

// Global "run dangerously" default, ON unless the user opted out — lives in ui/ (not api/) purely
// to avoid a ui → api import, since sessionsApi.js needs it too.
export function dangerousDefault() {
  return localStorage.getItem("globalDangerous") !== "0";
}

export const REVIEW_MODELS = [
  { value: "", label: "Inherit default" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "opus", label: "Opus 4.8" },
  { value: "haiku", label: "Haiku 4.5" },
  { value: "fable", label: "Fable 5" },
];

export function modelSelectHtml(id, selectedValue = "") {
  return `<select id="${id}">${REVIEW_MODELS.map(
    (m) => `<option value="${m.value}"${(selectedValue || "") === m.value ? " selected" : ""}>${m.label}</option>`
  ).join("")}</select>`;
}
export function dangerousCheckboxHtml(id) {
  return `<label class="modal-checkbox dangerous-label" title="Skips all tool-call confirmation prompts in the launched session"><input type="checkbox" id="${id}" ${dangerousDefault() ? "checked" : ""} /> ⚠ Run dangerously</label>`;
}
