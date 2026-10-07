import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { inScope, type Category, type Project } from "../categories/definition";
import { listInboxAccounts } from "../lib/inbox-sources";
import { BACKFILL_MESSAGES } from "../categories/store";
import { msg } from "../../shared/i18n";

/**
 * Projects and categories (CAT-1, CAT-2, SCR-13), behind the same Access and
 * same-origin boundary as every /api route. The feed side (a category's view,
 * chips and raising to Important) is in workers/routes/inbox.ts.
 */
export const categoriesRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;
const store = (c: C) => c.env.CATEGORIES.getByName("workspace");

/** A Durable Object error loses its class over RPC; its code travels as the message prefix. */
function failure(c: C, error: unknown) {
  const text = (error as Error)?.message ?? String(error);
  const m = text.match(/(not_found|invalid|conflict|limit): (.*)$/s);
  if (m) return c.json({ error: m[2] }, m[1] === "not_found" ? 404 : m[1] === "conflict" ? 409 : 400);
  console.error(JSON.stringify({ event: "categories_error", error: text.slice(0, 300) }));
  return c.json({ error: msg("Categories are unavailable right now. Try again.") }, 503);
}

categoriesRouter.use("/api/categories/*", async (c, next) => {
  if (!c.env.CATEGORIES) return c.json({ error: msg("Categories are not configured on this server; update the server from the app") }, 503);
  await next();
});
categoriesRouter.use("/api/categories", async (c, next) => {
  if (!c.env.CATEGORIES) return c.json({ error: msg("Categories are not configured on this server; update the server from the app") }, 503);
  await next();
});
categoriesRouter.use("/api/projects/*", async (c, next) => {
  if (!c.env.CATEGORIES) return c.json({ error: msg("Projects are not configured on this server; update the server from the app") }, 503);
  await next();
});
categoriesRouter.use("/api/projects", async (c, next) => {
  if (!c.env.CATEGORIES) return c.json({ error: msg("Projects are not configured on this server; update the server from the app") }, 503);
  await next();
});

/** The inboxes a category currently covers, so the sidebar can sum a scope category's unread. */
function covered(category: Category, accounts: { id: string; email: string }[], projects: Project[]) {
  return accounts.filter((a) => inScope(category.scope, a, projects)).map((a) => a.id);
}

categoriesRouter.get("/api/categories", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const [categories, projects, accounts] = await Promise.all([store(c).listCategories(), store(c).listProjects(), listInboxAccounts(c.env)]);
    return c.json({
      categories: categories.map((x) => ({ ...x, accountIds: covered(x, accounts, projects) })),
      projects,
      // For the scope picker: every inbox, by id and address.
      accounts: accounts.map((a) => ({ id: a.id, email: a.email, provider: a.provider })),
      limits: { backfill: BACKFILL_MESSAGES, dailyModelCalls: Number(c.env.CATEGORY_DAILY_LIMIT) || 500 },
    });
  } catch (error) { return failure(c, error); }
});

categoriesRouter.post("/api/categories", async (c) => {
  try {
    const category = await store(c).createCategory(await c.req.json().catch(() => null));
    console.log(JSON.stringify({ event: "category_created", kind: category.kind, all: category.scope.all, promote: category.promote }));
    return c.json(category, 201);
  } catch (error) { return failure(c, error); }
});

categoriesRouter.get("/api/categories/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const category = await store(c).getCategory(c.req.param("id"));
    return category ? c.json(category) : c.json({ error: msg("No such category") }, 404);
  } catch (error) { return failure(c, error); }
});

categoriesRouter.put("/api/categories/:id", async (c) => {
  try { return c.json(await store(c).updateCategory(c.req.param("id"), await c.req.json().catch(() => null))); }
  catch (error) { return failure(c, error); }
});

categoriesRouter.delete("/api/categories/:id", async (c) => {
  try { return (await store(c).deleteCategory(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: msg("No such category") }, 404); }
  catch (error) { return failure(c, error); }
});

categoriesRouter.post("/api/categories/:id/seen", async (c) => {
  try { await store(c).markSeen(c.req.param("id")); return c.body(null, 204); }
  catch (error) { return failure(c, error); }
});

categoriesRouter.get("/api/projects", async (c) => {
  c.header("Cache-Control", "no-store");
  try { return c.json({ projects: await store(c).listProjects() }); }
  catch (error) { return failure(c, error); }
});

categoriesRouter.post("/api/projects", async (c) => {
  try { return c.json(await store(c).createProject(await c.req.json().catch(() => null)), 201); }
  catch (error) { return failure(c, error); }
});

categoriesRouter.put("/api/projects/:id", async (c) => {
  try { return c.json(await store(c).updateProject(c.req.param("id"), await c.req.json().catch(() => null))); }
  catch (error) { return failure(c, error); }
});

categoriesRouter.delete("/api/projects/:id", async (c) => {
  try { return (await store(c).deleteProject(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: msg("No such project") }, 404); }
  catch (error) { return failure(c, error); }
});
