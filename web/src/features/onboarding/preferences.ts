const KEY = "depthguard.onboarding.v1";
let visited = false;

export function hasSeenOnboarding(): boolean {
  try {
    return visited || localStorage.getItem(KEY) === "seen";
  } catch {
    return visited;
  }
}

export function markOnboardingSeen(): void {
  visited = true;
  try {
    localStorage.setItem(KEY, "seen");
  } catch {
    // The guide remains usable when browser storage is unavailable.
  }
}

export function onboardingDestination(value: string | null): string {
  return value &&
    /^\/(?!\/)/.test(value) &&
    !/[\\\u0000-\u001f]/.test(value) &&
    !/^\/onboarding(?:[/?#]|$)/.test(value)
    ? value
    : "/explore";
}
