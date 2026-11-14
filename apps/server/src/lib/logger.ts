import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

/**
 * Request log with method, route pattern, status and duration only.
 * Never logs IP addresses, User-Agent, headers, query strings, bodies or concrete ids.
 */
export function privacyLogger(write: (line: string) => void = console.log): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    write(`${c.req.method} ${routePath(c)} ${c.res.status} ${ms}ms`);
  };
}
