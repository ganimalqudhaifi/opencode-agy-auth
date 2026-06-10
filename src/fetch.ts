type BunRequestInit = RequestInit & { proxy?: string };

export function agyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const proxy = process.env.OPENCODE_AGY_AUTH_PROXY;
  if (!proxy) {
    return fetch(input, init);
  }

  return fetch(input, {
    ...(init ?? {}),
    proxy
  } as BunRequestInit);
}
