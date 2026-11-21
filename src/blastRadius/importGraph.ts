import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseJsonc } from "./config.js";

/**
 * Count how many files import each file in a JS/TS repo, without running or
 * bundling any of its code. The scan reads source as text, finds import, export
 * from, dynamic import and require specifiers, and resolves them the way a
 * bundler would: relative paths, tsconfig `paths` aliases, and workspace
 * packages by name. It is a counting heuristic for blast radius, not a
 * compiler: an odd import it cannot resolve is simply not counted.
 */

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".svelte-kit",
  "out",
  "vendor",
]);
/** Stop scanning past this many source files, so a huge repo cannot stall CI. */
export const MAX_SCANNED_FILES = 20_000;

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Every module specifier a source file imports. */
export function findImportSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

interface PathAliases {
  /** Directory the alias targets are relative to. */
  baseDir: string;
  paths: Record<string, string[]>;
}

interface RepoIndex {
  root: string;
  /** Repo-relative paths of every scanned source file. */
  files: Set<string>;
  /** Directory (repo-relative, "" for root) to the aliases declared there. */
  aliases: Map<string, PathAliases>;
  /** Workspace package name to its repo-relative directory. */
  packages: Map<string, string>;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

async function walk(root: string, rel: string, index: RepoIndex, configs: string[]): Promise<void> {
  if (index.files.size >= MAX_SCANNED_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, child, index, configs);
    } else if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        if (index.files.size < MAX_SCANNED_FILES) index.files.add(child);
      } else if (/^tsconfig.*\.json$|^jsconfig\.json$|^package\.json$/.test(entry.name)) {
        configs.push(child);
      }
    }
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return parseJsonc(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Read `compilerOptions.paths` from a tsconfig, following a relative `extends` chain. */
async function readAliases(file: string, depth = 0): Promise<PathAliases | undefined> {
  const json = await readJson(file);
  if (!json || depth > 5) return undefined;
  const options = (json.compilerOptions ?? {}) as Record<string, unknown>;
  const dir = path.dirname(file);
  if (options.paths && typeof options.paths === "object") {
    const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
    return { baseDir: path.resolve(dir, baseUrl), paths: options.paths as Record<string, string[]> };
  }
  const parents = Array.isArray(json.extends) ? json.extends : [json.extends];
  for (const parent of parents) {
    if (typeof parent === "string" && parent.startsWith(".")) {
      const target = path.resolve(dir, parent.endsWith(".json") ? parent : `${parent}.json`);
      const found = await readAliases(target, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function buildIndex(root: string): Promise<RepoIndex> {
  const index: RepoIndex = { root, files: new Set(), aliases: new Map(), packages: new Map() };
  const configs: string[] = [];
  await walk(root, "", index, configs);
  for (const config of configs) {
    const dir = path.posix.dirname(config);
    const key = dir === "." ? "" : dir;
    if (config.endsWith("package.json")) {
      const json = await readJson(path.join(root, config));
      if (json && typeof json.name === "string" && key !== "") index.packages.set(json.name, key);
    } else if (!index.aliases.has(key)) {
      const aliases = await readAliases(path.join(root, config));
      if (aliases) index.aliases.set(key, aliases);
    }
  }
  return index;
}

/** Try a path as written, with each source extension, and as a directory index. */
function resolveFile(index: RepoIndex, absolute: string): string | undefined {
  const rel = toPosix(path.relative(index.root, absolute));
  if (rel.startsWith("..")) return undefined;
  const stems = [rel];
  // NodeNext-style imports name the emitted `.js` file; the source is `.ts`.
  const jsExt = rel.match(/\.(m|c)?jsx?$/);
  if (jsExt) stems.push(rel.slice(0, -jsExt[0].length));
  for (const stem of stems) {
    if (index.files.has(stem)) return stem;
    for (const ext of SOURCE_EXTENSIONS) {
      if (index.files.has(stem + ext)) return stem + ext;
    }
    for (const ext of SOURCE_EXTENSIONS) {
      if (index.files.has(`${stem}/index${ext}`)) return `${stem}/index${ext}`;
    }
  }
  return undefined;
}

function nearestAliases(index: RepoIndex, fileDir: string): PathAliases | undefined {
  let dir = fileDir;
  for (;;) {
    const found = index.aliases.get(dir);
    if (found) return found;
    if (dir === "") return undefined;
    const parent = path.posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
}

function resolveSpecifier(index: RepoIndex, importer: string, spec: string): string | undefined {
  const fileDir = path.posix.dirname(importer) === "." ? "" : path.posix.dirname(importer);
  if (spec.startsWith(".")) {
    return resolveFile(index, path.resolve(index.root, fileDir, spec));
  }

  const aliases = nearestAliases(index, fileDir);
  if (aliases) {
    for (const [pattern, targets] of Object.entries(aliases.paths)) {
      const star = pattern.indexOf("*");
      const prefix = star === -1 ? pattern : pattern.slice(0, star);
      const suffix = star === -1 ? "" : pattern.slice(star + 1);
      const matches =
        star === -1 ? spec === pattern : spec.startsWith(prefix) && spec.endsWith(suffix);
      if (!matches) continue;
      const captured = star === -1 ? "" : spec.slice(prefix.length, spec.length - suffix.length);
      for (const target of targets) {
        const hit = resolveFile(index, path.resolve(aliases.baseDir, target.replace("*", captured)));
        if (hit) return hit;
      }
    }
  }

  // A workspace package, imported by name: point at its source, not its build.
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const pkgDir = index.packages.get(name);
  if (pkgDir !== undefined) {
    const sub = spec.slice(name.length).replace(/^\//, "");
    const base = path.join(index.root, pkgDir);
    const candidates = sub
      ? [path.join(base, "src", sub), path.join(base, sub)]
      : [path.join(base, "src", "index"), path.join(base, "index")];
    for (const candidate of candidates) {
      const hit = resolveFile(index, candidate);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Scan the repo checked out at `root` and return, for each file, how many other
 * files import it directly.
 */
export async function countImporters(root: string): Promise<Map<string, number>> {
  const index = await buildIndex(root);
  const importers = new Map<string, Set<string>>();
  for (const file of index.files) {
    let source: string;
    try {
      source = await fs.readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const spec of findImportSpecifiers(source)) {
      const target = resolveSpecifier(index, file, spec);
      if (!target || target === file) continue;
      let set = importers.get(target);
      if (!set) importers.set(target, (set = new Set()));
      set.add(file);
    }
  }
  return new Map([...importers].map(([file, set]) => [file, set.size]));
}
