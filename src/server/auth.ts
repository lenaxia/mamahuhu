import type { Context, Next } from "hono";
import { ensureUser, type Sql, type UserRow } from "./db";

/**
 * Forward-auth identity. In production (TRUST_PROXY_HEADERS=1) the reverse
 * proxy supplies the username header (Authelia/Authentik/traefik). In dev the
 * x-dev-user header (or DEV_USER) identifies the user — this powers tests and
 * the dev-only user switcher.
 */
/** Whether the reverse proxy owns identity (production). False in dev. */
export const isProxyAuth = (): boolean => process.env.TRUST_PROXY_HEADERS === "1";

export function identityMiddleware(sql: Sql) {
  const trust = isProxyAuth();
  const authHeader = (process.env.AUTH_HEADER ?? "x-remote-user").toLowerCase();
  const nameHeader = (process.env.AUTH_NAME_HEADER ?? "x-remote-name").toLowerCase();
  const devUser = process.env.DEV_USER ?? "dad";

  return async (c: Context, next: Next) => {
    let ext: string | undefined;
    let name: string | undefined;
    if (trust) {
      ext = c.req.header(authHeader);
      name = c.req.header(nameHeader) ?? ext;
    } else {
      ext = c.req.header("x-dev-user") ?? devUser;
      name = ext;
    }
    if (!ext || ext.length < 1 || ext.length > 100) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const user = await ensureUser(sql, ext, name!);
    c.set("user", user);
    await next();
  };
}

declare module "hono" {
  interface ContextVariableMap {
    user: UserRow;
  }
}
