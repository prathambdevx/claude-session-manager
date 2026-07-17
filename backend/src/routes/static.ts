import { join } from "node:path";
import { PUBLIC_DIR, FRONTEND_SRC_DIR } from "../config.ts";

export async function handleStaticRoutes(req: Request, url: URL): Promise<Response | null> {
  // client-routed pages (SPA): "/" (main board) and "/projects/<encoded-cwd>" (drilled into one
  // project's own board) both serve the same index.html so a hard reload/deep link survives. Bare
  // "/projects" (from before the project picker was merged into the main board) is also matched
  // here as a harmless fallback — the client-side router just treats it as "main".
  if (req.method === "GET" && /^\/(projects(\/.*)?)?$/.test(url.pathname)) {
    return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
  }

  // component JS modules: index.html requests these at /src/**, served from frontend/src/ (a
  // sibling of frontend/public/, not nested under it)
  if (url.pathname.startsWith("/src/")) {
    const srcFile = Bun.file(join(FRONTEND_SRC_DIR, url.pathname.slice("/src/".length)));
    if (await srcFile.exists()) return new Response(srcFile);
    return new Response("Not found", { status: 404 });
  }

  // static files
  const file = Bun.file(join(PUBLIC_DIR, url.pathname));
  if (await file.exists()) return new Response(file);

  return null;
}
