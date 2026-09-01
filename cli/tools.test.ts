import { describe, expect, test } from "bun:test";

import { fallbackDirs, findIn, findTool, miseShimsDir, searchDirs } from "./tools.ts";

// The whole reason this module exists: Herdr spawns plugin actions with no login shell, so PATH may
// be minimal or absent (the pre-shim collie-ctl.sh). PATH is a hint here, never the mechanism.

const HOME = "/home/tester";

describe("searchDirs", () => {
  test("PATH entries come first, then the absolute fallbacks", () => {
    const dirs = searchDirs("/opt/x/bin:/opt/y/bin", HOME);
    expect(dirs.slice(0, 2)).toEqual(["/opt/x/bin", "/opt/y/bin"]);
    expect(dirs).toContain("/usr/bin");
  });

  test("with no PATH at all the fallbacks are the whole list", () => {
    expect(searchDirs(undefined, HOME)).toEqual(fallbackDirs(HOME));
    expect(searchDirs("", HOME)).toEqual(fallbackDirs(HOME));
  });

  test("relative and empty PATH entries are dropped", () => {
    // An empty entry means "the current directory" — resolving `git` through it would let whatever
    // directory we happen to be in supply the binary.
    const dirs = searchDirs(":.:relative/bin:/opt/ok", HOME);
    expect(dirs.filter((d) => !d.startsWith("/"))).toEqual([]);
    expect(dirs).toContain("/opt/ok");
  });

  test("every fallback dir is absolute and home-derived ones use the resolved home", () => {
    for (const d of fallbackDirs(HOME)) expect(d.startsWith("/")).toBe(true);
    expect(fallbackDirs(HOME)).toContain(`${HOME}/.bun/bin`);
    expect(fallbackDirs(HOME)).toContain(`${HOME}/.local/bin`);
  });

  test("a dir named twice is searched once", () => {
    const dirs = searchDirs("/usr/bin:/usr/bin", HOME);
    expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1);
  });
});

describe("miseShimsDir", () => {
  // The one location that is NOT guessable from the tool: mise keeps the real binaries under
  // `installs/<tool>/<version>/bin`, so a mise-only host resolved `bun` to nothing and every verb
  // that spawns it (`build`, `update`) failed on a box where `bun` worked in the operator's shell.
  test("defaults to mise's own default under the resolved home", () => {
    expect(miseShimsDir({}, HOME)).toBe(`${HOME}/.local/share/mise/shims`);
  });

  test("MISE_DATA_DIR wins over XDG_DATA_HOME, which wins over the default", () => {
    expect(miseShimsDir({ XDG_DATA_HOME: "/xdg" }, HOME)).toBe("/xdg/mise/shims");
    expect(miseShimsDir({ MISE_DATA_DIR: "/md", XDG_DATA_HOME: "/xdg" }, HOME)).toBe("/md/shims");
  });

  test("an override that is present but empty names no location", () => {
    // `MISE_DATA_DIR=` is how a caller scrubs it; treating "" as a path would search `/shims`.
    expect(miseShimsDir({ MISE_DATA_DIR: "", XDG_DATA_HOME: "" }, HOME)).toBe(
      `${HOME}/.local/share/mise/shims`,
    );
  });

  test("the shims dir is searched, ahead of a possibly-stale ~/.bun", () => {
    const dirs = fallbackDirs(HOME);
    expect(dirs).toContain(`${HOME}/.local/share/mise/shims`);
    expect(dirs.indexOf(`${HOME}/.local/share/mise/shims`)).toBeLessThan(
      dirs.indexOf(`${HOME}/.bun/bin`),
    );
  });

  test("findTool reaches a tool that ONLY the shims dir provides, with no PATH at all", () => {
    const shim = `${HOME}/.local/share/mise/shims/bun`;
    expect(findIn("bun", searchDirs(undefined, HOME), (p) => p === shim)).toBe(shim);
  });

  test("the overrides reach the search list, not just the helper", () => {
    expect(searchDirs(undefined, HOME, { MISE_DATA_DIR: "/md" })).toContain("/md/shims");
  });
});

describe("findTool", () => {
  // An absolute name is CHECKED WHERE IT IS, never searched for: `join(dir, "/usr/bin/tmux")` asks
  // after `/usr/bin/usr/bin/tmux` in every directory and answers "not installed" about a binary that
  // is right there. `collie doctor` runs the mux adapters' own resolved binary through this.
  test("an absolute name that exists resolves to itself, with no PATH at all", () => {
    expect(findTool(process.execPath, {}, HOME)).toBe(process.execPath);
  });

  test("an absolute name that does not exist is null, and no directory is searched for it", () => {
    expect(findTool("/nowhere/at/all/tmux", { PATH: "/usr/bin" }, HOME)).toBeNull();
  });
});

describe("findIn", () => {
  test("returns the first hit as an absolute path", () => {
    expect(findIn("git", ["/a", "/b"], (p) => p === "/b/git")).toBe("/b/git");
  });

  test("earlier dirs win", () => {
    expect(findIn("git", ["/a", "/b"], () => true)).toBe("/a/git");
  });

  test("nothing found is null, not a throw — the caller reports `X not found`", () => {
    expect(findIn("git", ["/a", "/b"], () => false)).toBeNull();
  });

  test("no dirs is null", () => {
    expect(findIn("git", [], () => true)).toBeNull();
  });
});
