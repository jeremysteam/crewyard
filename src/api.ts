export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const error=new Error(data.error || `Request failed (${response.status})`) as Error & { status: number; retryAfter: number };
    error.status=response.status;error.retryAfter=Number(response.headers.get('retry-after')||0);
    throw error;
  }
  return data as T;
}

export const post = <T>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
