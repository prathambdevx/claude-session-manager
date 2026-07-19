// Assigns each distinct project a stable color, reusing the same 9-slot palette
// (.col-pill-N/.chip.proj-color-N in styles.css) columns already use — so a project's card chip
// and its own column both read as the same color everywhere, not just within one board's layout.
import { sessions } from "../state.js";
import { projectName } from "./format.js";

const PALETTE_SIZE = 9;

/** Palette slot (1-9), or null if cwd is falsy/unknown — the single ranking both callers share. */
export function projectColorRank(cwd) {
  if (!cwd) return null;
  const cwds = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))].sort((a, b) =>
    projectName(a).localeCompare(projectName(b))
  );
  const rank = cwds.indexOf(cwd);
  return rank === -1 ? null : (rank % PALETTE_SIZE) + 1;
}

export function projectColorClass(cwd) {
  const rank = projectColorRank(cwd);
  return rank == null ? "" : `proj-color-${rank}`;
}
