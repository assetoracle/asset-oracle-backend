export function objectValue(value: unknown, path: string): unknown | null {
  if (!path || path.length > 160 || !/^[a-zA-Z0-9_$.-]+$/.test(path)) return null;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? null : current;
}
