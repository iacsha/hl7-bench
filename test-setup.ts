/**
 * test-setup.ts -- preloaded by `bun test` (see bunfig.toml).
 *
 * bun reads `.env` for tests too, and a site's `.env` names its own style with
 * HL7_BENCH_STYLE. The suite tests the TOOL's defaults, so a site setting must
 * not reach it: on a machine with a lean style file, every test of the default
 * output failed, reporting a correct lean class as wrong. Tests that want a
 * style pass one explicitly.
 */
delete process.env.HL7_BENCH_STYLE;
