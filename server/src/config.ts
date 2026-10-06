function port(value: string | undefined, fallback: number) {
  const p = Number(value ?? fallback);
  if (!Number.isInteger(p) || p < 1024 || p > 65535)
    throw new Error("Invalid local port.");
  return p;
}
export const API_PORT = port(process.env.DEPTHGUARD_API_PORT, 8790);
export const WEB_PORT = port(process.env.DEPTHGUARD_WEB_PORT, 5174);
export const API_HOST = process.env.DEPTHGUARD_HOST ?? "127.0.0.1";
const publicOrigin = process.env.DEPTHGUARD_PUBLIC_ORIGIN;
function origin(value: string) {
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("DEPTHGUARD_PUBLIC_ORIGIN must be an HTTP(S) origin.");
  return parsed.origin;
}
export const API_ORIGIN = publicOrigin
  ? origin(publicOrigin)
  : `http://127.0.0.1:${API_PORT}`;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
