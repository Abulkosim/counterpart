export const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
export const isStr = (x: unknown, min = 0, max = 4096): x is string =>
  typeof x === "string" && x.length >= min && x.length <= max;
export const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
// 32 raw bytes as unpadded base64url.
export const isKey = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x);
export const isId = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(x);

export function onlyKeys(x: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(x).every((k) => keys.includes(k)) && keys.every((k) => k in x);
}
