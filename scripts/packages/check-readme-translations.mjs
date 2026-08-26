// Scan every packages/**/package.json. For each one that has any
// README translation files on disk (README.ja.md, README.fr.md, …),
// verify that the published tarball actually ships them by running
// `npm pack --dry-run --json`.
//
// Usage:
//   node scripts/packages/check-readme-translations.mjs
//
// Exit 0 = clean (every on-disk translation lands in the tarball).
// Exit 1 = at least one translation is on disk but missing from the
//          tarball (e.g. excluded by `.npmignore` or a restrictive
//          `files` array combined with other edge cases).
//
// Motivation: README translations are easy to forget on the publish
// side. npm's default inclusion rules DO already cover `README*.md`
// without an explicit `files` entry, but `.npmignore` or other
// filter config can still drop them silently. Run this before any
// bulk publish as a pre-flight sanity check.

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "packages");

// Match README translations with a BCP-47-ish suffix (ja, ja-JP,
// pt-BR, etc.). README.md itself is excluded — that's the canonical
// one and ships by default.
export const TRANSLATION_RE = /^README\.[a-z]{2}(-[A-Z]{2})?\.md$/;

async function findPackageJsons(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "package.json") out.push(full);
    }
  }
  await walk(root);
  return out;
}

// Run `npm pack --dry-run --json` inside `cwd` and return the array
// of file entries the tarball would contain. The output prints to
// stderr when `--dry-run` is used — parse stdout, which carries the
// JSON.
// The one packed package out of `npm pack --json`, whatever shape npm used.
// npm <= 11 answered an ARRAY with one entry per packed package; npm 12 answers
// an OBJECT keyed by package name. Reading `parsed[0]` on the object yields
// `undefined`, so the previous version of this check saw an empty file list for
// every package and reported each of their translations as missing — the gate
// was red on a tarball that had shipped the file all along.
export function packEntry(parsed) {
  const candidate = Array.isArray(parsed) ? parsed[0] : isRecord(parsed) ? Object.values(parsed)[0] : null;
  return isRecord(candidate) && Array.isArray(candidate.files) ? candidate : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

async function packedFiles(cwd) {
  return new Promise((resolve, reject) => {
    // `--ignore-scripts` keeps `prepack` hooks (which often run
    // `yarn build` and pollute stdout with yarn's banner) from
    // corrupting the JSON output we're about to parse.
    const child = spawn("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`npm pack failed in ${cwd} (exit ${code})\n${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        const entry = packEntry(parsed);
        // Not "no files" — an unrecognised shape. Answering `[]` here would
        // report every translation as missing, which is exactly what npm 12's
        // change to this output did to the previous version of this check.
        if (!entry) {
          reject(new Error(`npm pack --json returned an unrecognised shape in ${cwd}; cannot verify the tarball`));
          return;
        }
        resolve((entry.files ?? []).map((file) => file.path));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function auditPackage(packageJsonPath) {
  const dir = path.dirname(packageJsonPath);
  const dirEntries = await readdir(dir).catch(() => []);
  const onDiskTranslations = dirEntries.filter((name) => TRANSLATION_RE.test(name));
  if (onDiskTranslations.length === 0) return { name: null, onDiskTranslations: [], missing: [] };

  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  // `npm pack` refuses to run on a private package without explicit
  // flags — treat private packages as "not published" and skip.
  if (pkg.private) return { name: pkg.name ?? path.basename(dir), onDiskTranslations, missing: [], skipped: "private" };

  const packed = await packedFiles(dir);
  const missing = onDiskTranslations.filter((name) => !packed.includes(name));
  return { name: pkg.name ?? path.basename(dir), onDiskTranslations, missing };
}

async function main() {
  const packageJsons = await findPackageJsons(PACKAGES_ROOT);
  const results = [];
  for (const pkgJson of packageJsons) {
    try {
      const result = await auditPackage(pkgJson);
      if (result.onDiskTranslations.length > 0) results.push({ ...result, packageJsonPath: pkgJson });
    } catch (err) {
      console.error(`[check:readmes] error auditing ${pkgJson}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (results.length === 0) {
    console.log(`[check:readmes] no packages have README translations on disk. Nothing to check.`);
    return 0;
  }

  const problems = results.filter((r) => r.missing.length > 0);
  console.log(`[check:readmes] scanned ${results.length} packages with README translations:`);
  for (const r of results) {
    const status = r.skipped ? `skipped (${r.skipped})` : r.missing.length === 0 ? "OK" : `MISSING: ${r.missing.join(", ")}`;
    console.log(`  ${r.name} — ${r.onDiskTranslations.join(", ")} — ${status}`);
  }

  if (problems.length > 0) {
    console.error(`\n[check:readmes] FAIL — ${problems.length} package(s) ship README translations on disk that are excluded from the tarball.`);
    console.error(`Check .npmignore and the 'files' array in the package.json of each flagged package.`);
    return 1;
  }

  return 0;
}

// Only run the CLI when invoked directly, so tests can import the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
