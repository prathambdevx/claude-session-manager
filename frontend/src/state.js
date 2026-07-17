// All shared mutable state, in one place, as live-exported bindings. Every other module imports
// exactly the pieces it needs from here instead of each owning its own copy — this is what lets
// the app stay split into many small files without threading state through every function call.
export let sessions = [];
export let agents = [];
export let delegations = [];
export let todos = [];
export let currentTab = localStorage.getItem("currentTab") || "sessions";
export let collapsedProjects = new Set(JSON.parse(localStorage.getItem("collapsedProjects") || "[]"));
export let expandedCards = new Set();
export let summarizingIds = new Set();
export let currentView = "board";

export const DEFAULT_COLUMNS = [
  { id: "todo", title: "All sessions" },
  { id: "in-progress", title: "In Progress" },
  { id: "priority", title: "Priority" },
  { id: "done", title: "Done" },
];
export const OLD_DEFAULT_ORDER = ["todo", "priority", "research", "in-progress", "done"];
export let boardColumns = DEFAULT_COLUMNS.slice();

export let boardMode = "main"; // "main" | "project" — set for real by routing/boardRouting.js at boot
export let activeProjectCwd = null;
export let projectBoards = {}; // Record<cwd, BoardColumn[]> — mirrors server's project-boards.json
export let currentProjectColumns = null; // BoardColumn[] for whichever project is currently drilled into

// The sidebar's own view switch — separate from boardMode above, which stays responsible for URL
// sync ("/" vs "/projects/<cwd>"). "group" (the read-only Projects lens) and "saved:<id>" (a saved
// view preview) aren't URL-routed — they're pure client display state, reset to boardMode's own
// view on reload, same as the design this mirrors.
export let activeView = "main"; // "main" | "project" | "group" | "saved:<id>"
export let savedViews = []; // SavedView[] — mirrors server's saved-views.json
export let defaultViewId = "main"; // mirrors server's board-settings.json
export let autoHideEmpty = false; // mirrors server's board-settings.json
export let boardHistory = []; // in-memory undo stack — transient, not persisted

export let contentMatchIds = new Set();
export let contentSearchTimer = null;
export let delegationPoll = null;

// Plain setters for every binding above, since `export let` can be reassigned by importers in
// most bundlers/engines but relying on that is fragile — these make every mutation explicit and
// keep the module the single source of truth.
export function setSessions(v) { sessions = v; }
export function setAgents(v) { agents = v; }
export function setDelegations(v) { delegations = v; }
export function setTodos(v) { todos = v; }
export function setCurrentTab(v) { currentTab = v; }
export function setExpandedCards(v) { expandedCards = v; }
export function setCurrentView(v) { currentView = v; }
export function setBoardColumns(v) { boardColumns = v; }
export function setBoardModeState(v) { boardMode = v; }
export function setActiveProjectCwd(v) { activeProjectCwd = v; }
export function setProjectBoards(v) { projectBoards = v; }
export function setCurrentProjectColumns(v) { currentProjectColumns = v; }
export function setContentMatchIds(v) { contentMatchIds = v; }
export function setContentSearchTimer(v) { contentSearchTimer = v; }
export function setDelegationPoll(v) { delegationPoll = v; }
export function setActiveView(v) { activeView = v; }
export function setSavedViews(v) { savedViews = v; }
export function setDefaultViewId(v) { defaultViewId = v; }
export function setAutoHideEmpty(v) { autoHideEmpty = v; }
export function setBoardHistory(v) { boardHistory = v; }
