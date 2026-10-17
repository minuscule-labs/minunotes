export function normalizeTagName(name: string) {
  return name
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
export function cleanTagName(name: string) {
  return normalizeTagName(name);
}
export function normalizeTagInput(input: string[]) {
  const seen = new Set<string>();
  const values: Array<{ name: string; normalizedName: string }> = [];
  for (const raw of input) {
    const name = cleanTagName(raw),
      normalizedName = normalizeTagName(raw);
    if (!name || !normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    values.push({ name, normalizedName });
  }
  return values.slice(0, 50);
}
