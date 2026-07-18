// All shared mutable state as live-exported bindings — lets the app stay split into small files
// without threading state through every function call.
export let sessions = [];
export let agents = [];
export let delegations = [];
export let quickPrompts = []; // QuickPromptJob[] — bundled into /api/sessions, same as delegations
export let todos = [];
export let currentTab = localStorage.getItem("currentTab") || "sessions";
export let collapsedProjects = new Set(JSON.parse(localStorage.getItem("collapsedProjects") || "[]"));
export let expandedCards = new Set();
export let summarizingIds = new Set();

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
export let groupBoardColumns = []; // BoardColumn[] for the "Projects" sidebar view — mirrors server's group-board.json

// Sidebar's own view switch, separate from boardMode (which stays responsible for URL sync) —
// "group"/"saved:<id>" aren't URL-routed, just client display state.
export let activeView = "main"; // "main" | "project" | "group" | "saved:<id>"
export let savedViews = []; // SavedView[] — mirrors server's saved-views.json
export let defaultViewId = "main"; // mirrors server's board-settings.json
export let autoHideEmpty = false; // mirrors server's board-settings.json
export let boardHistory = []; // in-memory undo stack — transient, not persisted

export let contentMatchIds = new Set();
export let contentSearchTimer = null;
export let delegationPoll = null;

// Plain setters for every binding above — relying on importers reassigning `export let` directly
// is fragile, so mutation always goes through these.
export function setSessions(v) { sessions = v; }
export function setAgents(v) { agents = v; }
export function setDelegations(v) { delegations = v; }
export function setQuickPrompts(v) { quickPrompts = v; }
export function setTodos(v) { todos = v; }
export function setCurrentTab(v) { currentTab = v; }
export function setExpandedCards(v) { expandedCards = v; }
export function setBoardColumns(v) { boardColumns = v; }
export function setBoardModeState(v) { boardMode = v; }
export function setActiveProjectCwd(v) { activeProjectCwd = v; }
export function setProjectBoards(v) { projectBoards = v; }
export function setCurrentProjectColumns(v) { currentProjectColumns = v; }
export function setGroupBoardColumns(v) { groupBoardColumns = v; }
export function setContentMatchIds(v) { contentMatchIds = v; }
export function setContentSearchTimer(v) { contentSearchTimer = v; }
export function setDelegationPoll(v) { delegationPoll = v; }
export function setActiveView(v) { activeView = v; }
export function setSavedViews(v) { savedViews = v; }
export function setDefaultViewId(v) { defaultViewId = v; }
export function setAutoHideEmpty(v) { autoHideEmpty = v; }
export function setBoardHistory(v) { boardHistory = v; }
