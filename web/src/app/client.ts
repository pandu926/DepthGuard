import type { components } from "../generated/backend-api";
export type Economy = components["schemas"]["Economy"];
export type Json = Record<string, any>;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
let csrf = sessionStorage.getItem("depthguard.csrf") ?? "";
export function setCsrf(value: string) {
  csrf = value;
  value
    ? sessionStorage.setItem("depthguard.csrf", value)
    : sessionStorage.removeItem("depthguard.csrf");
}
export async function request<T = Json>(
  path: string,
  body?: unknown,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: "same-origin",
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.code ?? "request_failed",
      data.error?.message ?? "The request could not be completed.",
    );
  return data;
}
export function atomic(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
  )
    throw Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error(`Use at most ${decimals} decimal places.`);
  const n =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (n <= 0n || n > 18446744073709551615n)
    throw Error("Amount is outside the supported token range.");
  return n.toString();
}
export function units(value: string | undefined, decimals = 9) {
  if (!value || !/^\d+$/.test(value)) return "—";
  const s = value.padStart(decimals + 1, "0");
  return decimals
    ? `${s.slice(0, -decimals)}.${s.slice(-decimals).replace(/0+$/, "") || "0"}`
    : s;
}
export function short(s: string | undefined) {
  return s ? `${s.slice(0, 5)}…${s.slice(-5)}` : "—";
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
