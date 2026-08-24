// TYRE-49. The type-aware tiers, not the syntactic ones: tsconfig already sets
// `strict` and CLAUDE.md forbids `any`, and only a rule with the type checker
// behind it can see an inferred `any` that never appears in the source. That is
// what `projectService` buys — without it these rules go quiet rather than
// fail, and a gate that cannot fail is not a gate.
//
// Recommended rather than `strictTypeChecked`, which pairs
// `no-non-null-assertion` with `non-nullable-type-assertion-style`: one forbids
// `!`, the other demands it, and code cannot satisfy both.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      // `.flat.` matters: the bare key is still the eslintrc shape, which flat
      // config rejects outright.
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
      // Last: turns off every rule Prettier owns, so the two gates cannot
      // disagree about the same line and fight each other in `make check`.
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The house rule from CLAUDE.md — "if you reach for `any`, the type is
      // wrong" — with the same weight as a compile error, not a warning.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Config, tooling and e2e files are not part of the app's tsconfig
  // project, so type-aware linting has no program to consult for them. The
  // e2e specs are still strictly typechecked — tsconfig.e2e.json, run by
  // `npm run typecheck` — just not type-aware-linted.
  {
    files: ["*.{js,ts}", "vite.config.ts", "playwright.config.ts", "e2e/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
