// TYRE-49: the type-aware tiers, not the syntactic ones. Only a rule with the
// type checker behind it (projectService) can see an inferred `any` that
// never appears in the source; without it these rules go quiet rather than
// fail.
//
// Recommended rather than strictTypeChecked, which pairs
// no-non-null-assertion with non-nullable-type-assertion-style: one forbids
// `!`, the other demands it.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import { moneyStaysString } from "./lint/moneyStaysString.js";

// House rules that need the type checker. Declared once so the typed block
// registers them and the untyped block can turn them off by name: a rule
// name a block's plugins do not know is a config error, not a silent skip.
const house = { rules: { "money-stays-string": moneyStaysString } };

// Rule 6's display half, enforced not remembered (TYRE-89, TYRE-95). Split
// into three constants because src/time is exempt from exactly one of them.
//
// toLocale* is banned by property name alone: syntax cannot tell a Date
// receiver from a Number, so toLocaleString deliberately also catches
// Number.prototype.toLocaleString, which formats identically to
// Intl.NumberFormat (ECMA-402).
const toLocaleBans = [
  {
    selector: "MemberExpression[property.name='toLocaleDateString']",
    message:
      "Render dates through formatTenantDate/useTenantDate (web/src/time/tenantTime.ts). The browser's zone is not the tenant's (rule 6).",
  },
  {
    selector: "MemberExpression[property.name='toLocaleTimeString']",
    message:
      "Render times through web/src/time/tenantTime.ts. The browser's zone is not the tenant's (rule 6).",
  },
  {
    selector: "MemberExpression[property.name='toLocaleString']",
    message:
      'Render dates through web/src/time/tenantTime.ts (rule 6). For a number, use Intl.NumberFormat("en-ZA").format(n). It gives the same output, and lint cannot tell the receivers apart.',
  },
];

// MemberExpression, not NewExpression: ECMA-402 makes Intl.DateTimeFormat
// callable without `new`, and either form formats in the browser's zone
// without touching toLocale* at all (rule 6, TYRE-95).
const intlDateTimeFormatBan = {
  selector: "MemberExpression[object.name='Intl'][property.name='DateTimeFormat']",
  message:
    "Render dates through formatTenantDate/useTenantDate (web/src/time/tenantTime.ts). The browser's zone is not the tenant's (rule 6).",
};

// `const { DateTimeFormat } = Intl` (or aliasing Intl itself) reaches the
// same browser-zone formatter without ever writing the member expression
// the ban above matches. Intl.NumberFormat is unaffected: call it through
// the global, not through an alias.
const intlAliasBan = {
  selector: "VariableDeclarator[init.name='Intl']",
  message:
    "Do not alias or destructure Intl. It reaches DateTimeFormat around the rule 6 ban. Reach the other Intl formatters through the global; dates go through web/src/time/tenantTime.ts.",
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
    plugins: { house },
    rules: {
      // The house rule from CLAUDE.md: "if you reach for `any`, the type is
      // wrong", with the same weight as a compile error, not a warning.
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": ["error", ...toLocaleBans, intlDateTimeFormatBan, intlAliasBan],
      // Rule 2's web half (spec U31): see web/lint/moneyStaysString.js.
      "house/money-stays-string": "error",
    },
  },
  // web/src/time/tenantTime.ts is the one legitimate home the bans above
  // point to (rule 6, TYRE-89). Only the Intl.DateTimeFormat construction it
  // needs is exempted; toLocale* and the Intl-alias ban still hold here
  // (TYRE-95).
  {
    files: ["src/time/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...toLocaleBans, intlAliasBan],
    },
  },
  // Config, tooling and e2e files sit outside the app's tsconfig project, so
  // type-aware linting has no program for them. They are still strictly
  // typechecked via tsconfig.e2e.json (npm run typecheck); just not
  // type-aware-linted.
  {
    files: [
      "*.{js,ts}",
      "vite.config.ts",
      "playwright.config.ts",
      "e2e/**/*.ts",
      "lint/**/*.{js,ts}",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    // Flat config resolves a rule's plugin per block, so a block naming
    // house/... without declaring house is a config error, not a skip.
    plugins: { house },
    rules: { "house/money-stays-string": "off" },
  },
);
