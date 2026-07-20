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
// sessionId -> the exact lastActivity text dismissed — the "done" chip has no backing job record
// (it's inferred straight from the transcript), so dismissal is a client-side-only marker that
// naturally clears itself once a new activity line makes the stored value stop matching.
export let dismissedDoneChips = new Map();

// Todos board's own columns — separate from the sessions board entirely, mirrors server's
// todo-board.json. Seeded on a brand-new install only (nothing saved yet).
export const DEFAULT_TODO_COLUMNS = [
  { id: "to-do", title: "Todo" },
  { id: "in-progress", title: "In Progress" },
  { id: "done", title: "Done" },
];
export let todoBoardColumns = DEFAULT_TODO_COLUMNS.slice();

export let groupBoardColumns = []; // BoardColumn[] for the "All Projects" lens — mirrors server's group-board.json

// Which view is showing — kept in sync with the URL by routing/boardRouting.js (every view is a
// real route now, so a refresh stays put).
export let activeView = "group"; // "group" | "saved:<id>"
export let savedViews = []; // SavedView[] — mirrors server's saved-views.json
// false until the first GET /api/sessions resolves — a /views/<id> deep link's very first render()
// call happens before that, when savedViews is still empty, so a missing-view check must wait for
// this or it misreads "not loaded yet" as "that view was deleted."
export let sessionsLoaded = false;
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
export function setTodoBoardColumns(v) { todoBoardColumns = v; }
export function setGroupBoardColumns(v) { groupBoardColumns = v; }
export function setContentMatchIds(v) { contentMatchIds = v; }
export function setContentSearchTimer(v) { contentSearchTimer = v; }
export function setDelegationPoll(v) { delegationPoll = v; }
export function setActiveView(v) { activeView = v; }
export function setSessionsLoaded(v) { sessionsLoaded = v; }
export function setSavedViews(v) { savedViews = v; }
export function setBoardHistory(v) { boardHistory = v; }
export function dismissDoneChip(sessionId, activity) { dismissedDoneChips.set(sessionId, activity); }
