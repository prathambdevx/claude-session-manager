// dark/light toggle — defaults to dark regardless of OS preference; index.html's inline
// pre-paint script already stamps data-theme on <html> before this ever runs.
export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

export function updateThemeIcon() {
  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;
  const dark = currentTheme() === "dark";
  btn.textContent = dark ? "☀️" : "🌙";
  btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}

const themeSound = new Audio("/assets/theme-click.mp3");
themeSound.preload = "auto";
export function playThemeSound() {
  themeSound.currentTime = 0;
  themeSound.play().catch(() => {}); // ignore autoplay-policy rejections — never block the toggle
}

export function initThemeToggle() {
  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    updateThemeIcon();
    playThemeSound();
  });
  updateThemeIcon();
}
