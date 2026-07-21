export function normalizeNpmPackResult(value) {
  const pack = Array.isArray(value)
    ? value[0]
    : value && typeof value === "object"
      ? Object.values(value)[0]
      : undefined;

  if (!pack || typeof pack !== "object" || !Array.isArray(pack.files)) {
    throw new Error("npm pack --json returned an unexpected shape");
  }

  return pack;
}
