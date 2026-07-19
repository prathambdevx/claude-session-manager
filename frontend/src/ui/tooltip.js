// Custom-styled tooltip for elements marked with data-tooltip="...", rendered into document.body
// (not as a descendant of the hovered element) so it can't get clipped by an ancestor's overflow —
// several board containers set overflow-x/y for scrolling, which per the CSS spec forces the OTHER
// axis non-visible too, silently clipping anything absolutely-positioned inside them.
let tipEl = null;
let showTimer = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "custom-tooltip";
  document.body.appendChild(tipEl);
  return tipEl;
}

function positionTip(target) {
  const rect = target.getBoundingClientRect();
  const tip = ensureTipEl();
  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.style.visibility = "hidden";
  tip.style.display = "block";
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tipRect.width - 6));
  const spaceAbove = rect.top;
  const showBelow = spaceAbove < tipRect.height + 10;
  const top = showBelow ? rect.bottom + 8 : rect.top - tipRect.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.classList.toggle("below", showBelow);
  tip.style.visibility = "visible";
}

function hideTip() {
  clearTimeout(showTimer);
  if (tipEl) tipEl.style.display = "none";
}

// Wires every data-tooltip element under root — call this once per render, same as other
// wireX(app) helpers, since the DOM is rebuilt wholesale each time.
export function wireTooltips(root) {
  root.querySelectorAll("[data-tooltip]").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      const text = el.dataset.tooltip;
      if (!text) return;
      showTimer = setTimeout(() => {
        const tip = ensureTipEl();
        tip.textContent = text;
        positionTip(el);
      }, 250);
    });
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("click", hideTip);
  });
}
