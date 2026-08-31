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

// Rule 6's display half, enforced rather than remembered (TYRE-89, TYRE-95).
// Split into three constants because src/time — the funnel every other file
// must render through — is exempt from exactly one of them, and a list
// written twice would drift.
//
// The toLocale* methods are banned by property name alone. Syntax cannot
// tell a Date receiver from a Number, so `toLocaleString` catches
// Number.prototype.toLocaleString too — deliberately: a receiver-shape
// heuristic would let any Date reached through a property or call slip
// past, and numbers have Intl.NumberFormat, which formats identically
// (ECMA-402 defines Number's toLocaleString as exactly that call).
const toLocaleBans = [
  {
    selector: "MemberExpression[property.name='toLocaleDateString']",
    message:
      "Render dates through formatTenantDate/useTenantDate (web/src/time/tenantTime.ts) — the browser's zone is not the tenant's (rule 6).",
  },
  {
    selector: "MemberExpression[property.name='toLocaleTimeString']",
    message:
      "Render times through web/src/time/tenantTime.ts — the browser's zone is not the tenant's (rule 6).",
  },
  {
    selector: "MemberExpression[property.name='toLocaleString']",
    message:
      'Render dates through web/src/time/tenantTime.ts (rule 6). For a number, use Intl.NumberFormat("en-ZA").format(n) — same output, and lint cannot tell the receivers apart.',
  },
];

// MemberExpression, not NewExpression: ECMA-402 makes Intl.DateTimeFormat
// callable without `new`, and either form — or a bare alias of the member —
// formats in the browser's zone without touching toLocale* at all (rule 6,
// TYRE-95).
const intlDateTimeFormatBan = {
  selector: "MemberExpression[object.name='Intl'][property.name='DateTimeFormat']",
  message:
    "Render dates through formatTenantDate/useTenantDate (web/src/time/tenantTime.ts) — the browser's zone is not the tenant's (rule 6).",
};

// `const { DateTimeFormat } = Intl` (or aliasing Intl itself) reaches the
// same browser-zone formatter without ever writing the member expression
// the ban above matches. Intl.NumberFormat is unaffected: call it through
// the global, not through an alias.
const intlAliasBan = {
  selector: "VariableDeclarator[init.name='Intl']",
  message:
    "Do not alias or destructure Intl — it reaches DateTimeFormat around the rule 6 ban. Reach the other Intl formatters through the global; dates go through web/src/time/tenantTime.ts.",
};

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
      "no-restricted-syntax": ["error", ...toLocaleBans, intlDateTimeFormatBan, intlAliasBan],
    },
  },
  // web/src/time/tenantTime.ts is the one legitimate home the date bans
  // above all point to — the funnel every other file is required to render
  // through (rule 6, TYRE-89). Only the Intl.DateTimeFormat construction the
  // formatter genuinely needs is exempted; the toLocale* and Intl-alias bans
  // still hold here, so a second file in this directory cannot quietly call
  // toLocaleDateString() (TYRE-95).
  {
    files: ["src/time/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...toLocaleBans, intlAliasBan],
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
