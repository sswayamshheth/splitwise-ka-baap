/** Tiny JSON client for our API routes. Errors carry the server's message. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Calm wording when the server didn't send its own message (e.g. a gateway error page). */
export function fallbackMessage(status: number): string {
  if (status === 0) return "Can't reach GroupTrip right now — check your connection and try again.";
  if (status === 401) return "Please sign in again to continue.";
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "That couldn't be found.";
  if (status >= 500) return "Something went wrong on our side — please try again in a moment.";
  return "Something went wrong — please try again.";
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    // Offline or the request never reached us: never show the browser's "Failed to fetch".
    throw new ApiError(0, fallbackMessage(0));
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" && data.error.trim() ? data.error : fallbackMessage(res.status), data);
  return data as T;
}
