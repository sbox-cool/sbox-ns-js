// The camelCase names scripts use for workflows (`workflows.grantXp(input)`) and globals (`globals.inventory`).
// Mirrors the server's rule (ScriptWorkflowAliases.cs): split on runs of non-alphanumerics, lowercase the first
// segment's first letter and uppercase the rest, keep the remaining characters, and require ^[A-Za-z][A-Za-z0-9]*$.
const SEPARATORS = /[^A-Za-z0-9]+/;
const VALID_ALIAS = /^[A-Za-z][A-Za-z0-9]*$/;

export function aliasOf(id: string): string | null {
  const segments = id.split(SEPARATORS).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const alias = segments
    .map((segment, index) => (index === 0 ? segment.charAt(0).toLowerCase() : segment.charAt(0).toUpperCase()) + segment.slice(1))
    .join("");
  return VALID_ALIAS.test(alias) ? alias : null;
}

// Alias to id. An alias shared by two ids belongs to neither; both stay reachable by id.
export function aliasTable(ids: readonly string[]): Map<string, string> {
  const owners = new Map<string, string[]>();
  for (const id of [...ids].sort()) {
    const alias = aliasOf(id);
    if (alias === null) continue;
    owners.set(alias, [...(owners.get(alias) ?? []), id]);
  }
  const table = new Map<string, string>();
  for (const [alias, list] of owners) {
    const [only] = list;
    if (list.length === 1 && only !== undefined) table.set(alias, only);
  }
  return table;
}
