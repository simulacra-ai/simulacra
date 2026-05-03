import { defineConfig, type Options } from "tsup";

/**
 * Shared tsup base for workspace packages. Every package has the same
 * format/dts/sourcemap settings; only `entry` varies. Use this from a
 * package's tsup.config.ts:
 *
 * ```ts
 * import { create_tsup_config } from "../../tsup.config.base.ts";
 * export default create_tsup_config({ entry: ["src/index.ts"] });
 * ```
 */
export function create_tsup_config(overrides: Pick<Options, "entry"> & Partial<Options>) {
  return defineConfig({
    format: ["esm", "cjs"],
    dts: {
      compilerOptions: {
        composite: false,
      },
    },
    sourcemap: true,
    clean: true,
    ...overrides,
  });
}
