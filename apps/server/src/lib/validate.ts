import type { Context } from 'hono';
import type { z } from 'zod';
import { apiError } from '../context.js';

/** Parse and validate a JSON body. Validation errors never echo the submitted values. */
export async function jsonBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    apiError(400, 'invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) apiError(400, 'invalid_request');
  return parsed.data;
}
