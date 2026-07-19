// HTTP request routing: tries each resource's route module in turn (same effective order as the
// original single-file router) and returns the first non-null Response.
export { startClearReconciliationPoller } from "./reconcile.ts";
export { startFsWatcher } from "../fsWatcher.ts";
import { handleEventsRoutes } from "./events.ts";
import { handleSessionsRoutes } from "./sessions.ts";
import { handleBoardRoutes } from "./board.ts";
import { handleSavedViewsRoutes } from "./savedViews.ts";
import { handleAgentsRoutes } from "./agents.ts";
import { handleDelegationsRoutes } from "./delegations.ts";
import { handleQuickPromptRoutes } from "./quickPrompts.ts";
import { handleImagesRoutes } from "./images.ts";
import { handleTicketsRoutes } from "./tickets.ts";
import { handleProjectsRoutes } from "./projects.ts";
import { handleSearchRoutes } from "./search.ts";
import { handleLaunchRoutes } from "./launch.ts";
import { handleReviewsRoutes } from "./reviews.ts";
import { handleContextsRoutes } from "./contexts.ts";
import { handleTodosRoutes } from "./todos.ts";
import { handlePermissionsRoutes } from "./permissions.ts";
import { handleStaticRoutes } from "./static.ts";

const ROUTE_HANDLERS = [
  handleEventsRoutes,
  handleSessionsRoutes,
  handleBoardRoutes,
  handleSavedViewsRoutes,
  handleAgentsRoutes,
  handleDelegationsRoutes,
  handleQuickPromptRoutes,
  handleImagesRoutes,
  handleTicketsRoutes,
  handleProjectsRoutes,
  handleSearchRoutes,
  handleLaunchRoutes,
  handleReviewsRoutes,
  handleContextsRoutes,
  handleTodosRoutes,
  handlePermissionsRoutes,
  handleStaticRoutes,
];

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  for (const handler of ROUTE_HANDLERS) {
    const res = await handler(req, url);
    if (res) return res;
  }
  return new Response("Not found", { status: 404 });
}
