// dark/light toggle — data-theme on <html> overrides prefers-color-scheme; its absence means
// "follow the OS".
export function currentTheme() {
  const override = document.documentElement.getAttribute("data-theme");
  if (override) return override;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  // if the user hasn't explicitly chosen a theme, keep the icon in sync with OS changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem("theme")) updateThemeIcon();
  });
  updateThemeIcon();
}
