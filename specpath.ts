/**
 * specpath.ts -- WHICH file holds the spec. Nothing else.
 *
 * Split from `specfile.ts` on purpose. Resolving the path has no side effects;
 * loading the module runs it and refuses to continue when the file is missing.
 * The GUI needs the first and must not have the second, because the file the GUI
 * exists to write is allowed not to exist yet: pointing HL7_BENCH_TRANSFORM at a
 * new path and opening the GUI to author the spec there has to work, and a
 * loader that dies on a missing file would make the GUI unstartable in exactly
 * that case.
 */

import { isAbsolute, join, resolve } from "node:path";

/** The spec that ships with the tool. Synthetic, tracked, safe to publish. */
export const DEFAULT_SPEC_PATH = join(import.meta.dir, "transform.ts");

/** Trimmed, because a trailing space in an environment variable is invisible. */
const override = process.env.HL7_BENCH_TRANSFORM?.trim();

/**
 * Relative paths resolve against the working directory, not this folder. A
 * relative path in an environment variable reads as "relative to where I am",
 * and the alternative silently points somewhere else.
 */
export const specPath: string = override
  ? isAbsolute(override)
    ? override
    : resolve(process.cwd(), override)
  : DEFAULT_SPEC_PATH;

export const specIsExternal = specPath !== DEFAULT_SPEC_PATH;

/** What the variable was set to, for error messages that can be acted on. */
export const specOverride = override;
