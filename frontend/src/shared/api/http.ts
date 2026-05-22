function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

export async function getJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const raw = await response.text();
  let payload: unknown;

  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw);
    } catch {
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      throw new Error("Expected JSON response");
    }
  }

  const errorMessage = readErrorMessage(payload);
  if (!response.ok || errorMessage) {
    throw new Error(errorMessage ?? `Request failed: ${response.status}`);
  }

  return payload as T;
}

export function postJson<T>(input: RequestInfo | URL, body?: unknown, init?: RequestInit) {
  return getJson<T>(input, {
    ...init,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function post<T>(input: RequestInfo | URL, init?: RequestInit) {
  return getJson<T>(input, {
    ...init,
    method: "POST",
  });
}

export function deleteJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  return getJson<T>(input, {
    ...init,
    method: "DELETE",
  });
}
