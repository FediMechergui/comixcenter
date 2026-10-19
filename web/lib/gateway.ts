/** Public deployment address only. Credentials belong to the gateway's server environment. */
const KEY = "comix.gateway";
const BUILT_IN = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "https://comixcenter-gateway.vercel.app";

export function gatewayUrl(): string | null {
  let value = BUILT_IN;
  try { value = localStorage.getItem(KEY) || value; } catch { /* SSR or unavailable storage */ }
  return value ? value.replace(/\/+$/, "") : null;
}
export function setGatewayUrl(value: string | null) {
  if (value) {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("Use an HTTPS gateway address");
    if (parsed.username || parsed.password) throw new Error("Gateway addresses cannot contain credentials");
  }
  if (value) localStorage.setItem(KEY, value.replace(/\/+$/, "")); else localStorage.removeItem(KEY);
}
export async function gatewayRequest<T>(path: string, timeoutMs = 12_000): Promise<T> {
  const origin = gatewayUrl();
  if (!origin) throw new Error("No hosted gateway is configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}${path}`, { signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : `Gateway answered ${response.status}`);
    return body as T;
  } catch (e) {
    if (controller.signal.aborted) throw new Error("The hosted source did not answer in time. Choose another source.");
    throw e;
  } finally { clearTimeout(timer); }
}
