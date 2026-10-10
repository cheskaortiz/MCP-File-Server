/**
 * Minimal glob support (no dependency): `*` (no slash), `**` (any depth), `?`.
 * Braces and character classes are NOT supported. Matching is case-insensitive.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        if (glob.charAt(i + 2) === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/** Patterns without "/" match the file name; patterns with "/" match the workspace-relative path. */
export function makeGlobMatcher(glob: string): (relPath: string) => boolean {
  const re = globToRegExp(glob);
  const usePath = glob.includes("/");
  return (rel) => re.test(usePath ? rel : rel.slice(rel.lastIndexOf("/") + 1));
}
