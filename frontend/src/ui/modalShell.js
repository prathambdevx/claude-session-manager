import { delegationPoll, setDelegationPoll } from "../state.js";

export function modalShell(inner, width) {
  const root = document.getElementById("modalRoot");
  const widthStyle = width ? ` style="width:${width}px;"` : "";
  root.innerHTML = `<div class="modal-overlay" id="modalOverlay"><div class="modal"${widthStyle}>${inner}</div></div>`;
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") closeReviewModal();
  });
}

export function closeReviewModal() {
  if (delegationPoll) { clearInterval(delegationPoll); setDelegationPoll(null); }
  document.getElementById("modalRoot").innerHTML = "";
}
