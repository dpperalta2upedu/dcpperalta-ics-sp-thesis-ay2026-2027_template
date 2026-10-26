import { clearSandboxAuthState, getSandboxAuthState } from "./sb_auth";

export async function sandboxFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const auth = getSandboxAuthState();
  const headers = new Headers(init.headers ?? {});
  if (auth.authorization) {
    headers.set("Authorization", auth.authorization);
  }

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    clearSandboxAuthState();
  }
  return response;
}
