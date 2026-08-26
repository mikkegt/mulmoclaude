// Type declarations for check-readme-translations.mjs. Sidecar so the script
// stays plain JS (runnable with `node` on a fresh clone) while tests get a typed
// import surface — same arrangement as scripts/packages/audit-releases.d.mts.

/** One file inside a packed tarball, as `npm pack --json` describes it. */
export interface PackedFile {
  path: string;
}

/** One packed package out of `npm pack --json`. */
export interface PackEntry {
  name?: string;
  files: PackedFile[];
}

/** Matches a README translation (`README.ja.md`, `README.pt-BR.md`). The
 *  canonical `README.md` is deliberately NOT a match — it ships by default. */
export const TRANSLATION_RE: RegExp;

/** The single packed package, whichever shape npm used: an array (npm <= 11) or
 *  an object keyed by package name (npm 12). Null when the value is neither —
 *  which the caller must treat as "cannot verify", never as "no files". */
export function packEntry(parsed: unknown): PackEntry | null;
