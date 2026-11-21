/**
 * Turn a path glob into a RegExp that matches a whole repo-relative path.
 *
 * Supported syntax, which is all the rules need:
 * - `*`   any run of characters except `/`
 * - `**` any run of characters, `/` included
 * - `**\/` zero or more whole directories, so `**\/*.md` also matches `README.md`
 * - `?`   one character except `/`
 *
 * Everything else is literal. Matching is case-sensitive, like git paths.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Compile a list of globs once into a single matcher. */
export function compileGlobs(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((re) => re.test(path));
}
