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

// Home column ("All sessions", id "all-sessions") always shows every session; the rest are status
// columns. The home column is identified positionally (cols[0]), so its id is just a stable label.
export const DEFAULT_COLUMNS = [
  { id: "all-sessions", title: "All sessions" },
  { id: "to-do", title: "Todo" },
  { id: "in-progress", title: "In Progress" },
  { id: "done", title: "Done" },
];
export const OLD_DEFAULT_ORDER = ["todo", "priority", "research", "in-progress", "done"];
// Individual project boards start with just the home column — only Main board gets the full
// starter set (Todo/In Progress/Done); you add your own from there if you want more.
export const PROJECT_DEFAULT_COLUMNS = [{ id: "all-sessions", title: "All sessions" }];
export let boardColumns = DEFAULT_COLUMNS.slice();

export let boardMode = "main"; // "main" | "project" — set for real by routing/boardRouting.js at boot
export let activeProjectCwd = null;
export let projectBoards = {}; // Record<cwd, BoardColumn[]> — mirrors server's project-boards.json
export let currentProjectColumns = null; // BoardColumn[] for whichever project is currently drilled into
export let groupBoardColumns = []; // BoardColumn[] for the "Projects" sidebar view — mirrors server's group-board.json

// Which view is showing — kept in sync with the URL by routing/boardRouting.js (every view is a
// real route now, so a refresh stays put).
export let activeView = "main"; // "main" | "project" | "group" | "saved:<id>"
export let savedViews = []; // SavedView[] — mirrors server's saved-views.json
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
export function setAutoHideEmpty(v) { autoHideEmpty = v; }
export function setBoardHistory(v) { boardHistory = v; }
