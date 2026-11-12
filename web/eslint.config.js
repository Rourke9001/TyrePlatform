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

// Rule 6's display half, enforced not remembered (TYRE-89, TYRE-95). Each
// ban is its own constant, gathered below into appBans; the time and route
// error boundary blocks each drop exactly one of them.
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
      "Render dates through web/src/time/tenantTime.ts (rule 6) and group numbers through groupThousands (web/src/format/groupThousands.ts, U55). Lint cannot tell the receivers apart.",
  },
];

// MemberExpression, not NewExpression: ECMA-402 makes Intl.DateTimeFormat
// callable without `new`, and either form formats in the browser's zone
// without touching toLocale* at all (rule 6, TYRE-95). The second selector
// is globalThis.Intl or window.Intl.
const intlDateTimeFormatBan = {
  selector:
    "MemberExpression[object.name='Intl'][property.name='DateTimeFormat'], MemberExpression[object.property.name='Intl'][property.name='DateTimeFormat']",
  message:
    "Render dates through formatTenantDate/useTenantDate (web/src/time/tenantTime.ts). The browser's zone is not the tenant's (rule 6).",
};

// `const { DateTimeFormat } = Intl` (or aliasing Intl itself) reaches a
// banned formatter without ever writing the member expression its ban
// matches.
const intlAliasBan = {
  selector: "VariableDeclarator[init.name='Intl']",
  message:
    "Do not alias or destructure Intl. It reaches DateTimeFormat and NumberFormat around their bans: dates go through web/src/time/tenantTime.ts (rule 6), numbers through groupThousands (web/src/format/groupThousands.ts, U55).",
};

// U55: every displayed number groups with a comma, written once in
// web/src/format/groupThousands.ts. Intl.NumberFormat("en-ZA") groups with a
// no-break space and would put a second convention beside money's. The
// second selector is globalThis.Intl or window.Intl.
const intlNumberFormatBan = {
  selector:
    "MemberExpression[object.name='Intl'][property.name='NumberFormat'], MemberExpression[object.property.name='Intl'][property.name='NumberFormat']",
  message:
    "Group a displayed number through groupThousands (web/src/format/groupThousands.ts). A comma everywhere, as money does (U55).",
};

// U54: function components only, with one named exception, the route error
// boundary, since React catches a render error only in a class.
const classComponentBan = {
  selector:
    "ClassDeclaration[superClass.name=/^(Pure)?Component$/], ClassDeclaration[superClass.property.name=/^(Pure)?Component$/], ClassExpression[superClass.name=/^(Pure)?Component$/], ClassExpression[superClass.property.name=/^(Pure)?Component$/], ImportDeclaration[importKind!='type'] > ImportSpecifier[importKind!='type'][imported.name=/^(Pure)?Component$/]",
  message:
    "Function components only (CLAUDE.md). The one exception is src/shell/RouteErrorBoundary.tsx (U54).",
};

// Every no-restricted-syntax block writes this list, less at most one
// exemption, because a block's array replaces an earlier block's rather
// than adding to it.
const appBans = [
  ...toLocaleBans,
  intlDateTimeFormatBan,
  intlAliasBan,
  intlNumberFormatBan,
  classComponentBan,
];

// CSS's named colours. transparent and currentColor name no colour of their
// own, so they stay allowed.
const namedColours = `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
  chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
  darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet
  deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green
  greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender
  lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
  lightyellow lime limegreen linen magenta maroon mediumaquamarine
  mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange
  orangered orchid palegoldenrod palegreen paleturquoise palevioletred
  papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna
  silver skyblue slateblue slategray slategrey snow springgreen steelblue
  tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen
`
  .trim()
  .split(/\s+/)
  .join("|");

// CSS Color 4's hex notation has 3, 4, 6 or 8 digits.
const hexDigits = "(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})";

const wholeHex = String.raw`/^\s*#${hexDigits}\s*$/`;

// Not a colour: url(#fade), which names an SVG element, an entity such as
// &#8230;, or the start of an id such as #add-driver.
const hexToken = String.raw`/(?<!&|url\(\s*["']?)#${hexDigits}(?![\w-])/`;

const colourFunction = String.raw`/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/`;

// An esquery regex ends at its first slash, so one inside it is written \x2f.
const slash = String.raw`\x2f`;

// A colour word in a path such as "./red.svg" names a file.
const namedColour = String.raw`/(?<![-\w.#${slash}])(?:${namedColours})(?![-\w.])/i`;

const styleKey = String.raw`/^(?:color|fill|stroke|stopColor|floodColor|lightingColor|background\w*|border\w*|outline\w*|boxShadow|textShadow|caretColor|accentColor|textDecorationColor|columnRuleColor)$/`;

// A string is a Literal's value or a TemplateElement's raw text, so a
// comment never reaches these.
const colourString = (pattern) =>
  `:matches(Literal[value=${pattern}], TemplateElement[value.raw=${pattern}])`;

// Every shape that hands a style key a value. A type paints nothing, so no
// type node is one (docs/superpowers/specs/2026-11-12-colour-gate-parsers-design.md,
// The TSX half).
const styleValue = `:matches(${[
  // A quoted key is that key, bracketed or not, and a bracketed expression
  // names nothing (TYRE-95).
  `Property[computed=false][key.name=${styleKey}]`,
  `Property[key.value=${styleKey}]`,
  `JSXAttribute[name.name=${styleKey}]`,
  `AssignmentExpression[left.computed=false][left.property.name=${styleKey}]`,
  `AssignmentExpression[left.property.value=${styleKey}]`,
  `AssignmentExpression[left.name=${styleKey}]`,
  `VariableDeclarator[id.name=${styleKey}]`,
  `AssignmentPattern[left.name=${styleKey}]`,
  `PropertyDefinition[computed=false][key.name=${styleKey}]`,
  `PropertyDefinition[key.value=${styleKey}]`,
  `AccessorProperty[computed=false][key.name=${styleKey}]`,
  `AccessorProperty[key.value=${styleKey}]`,
  `TSEnumMember[id.name=${styleKey}]`,
  `TSEnumMember[id.value=${styleKey}]`,
].join(", ")})`;

const colourRemedy = "Read the token's custom property instead (web/CLAUDE.md, TYRE-27).";

// TYRE-27, TYRE-445: a colour reaches a component only through a custom
// property that src/theme/tokens.ts defines.
const colourBans = [
  {
    selector: colourString(wholeHex),
    message: `A hex colour outside src/theme/tokens.ts. ${colourRemedy}`,
  },
  {
    selector: colourString(colourFunction),
    message: `A colour function outside src/theme/tokens.ts. ${colourRemedy}`,
  },
  {
    selector: `${styleValue} ${colourString(hexToken)}`,
    message: `A hex colour in a style value. ${colourRemedy}`,
  },
  {
    selector: `${styleValue} ${colourString(namedColour)}`,
    message: `A named colour in a style value. ${colourRemedy}`,
  },
];

// ADR-0022's import rules, one pattern group each. A later block's list
// replaces an earlier one's for the same file, so every block below writes
// its whole list. A type import may cross, since it ships no code.
const dexieBan = {
  group: ["dexie"],
  allowTypeImports: true,
  message:
    "Only capture/outbox.ts, capture/draft.ts and capture/useOutbox.ts open Dexie (ADR-0022, ADR-0009).",
};

const uiBans = {
  group: [
    "**/api/**",
    "**/auth/**",
    "**/capture/**",
    "**/driver/**",
    "**/dashboard/**",
    "**/fleet/**",
    "**/admin/**",
    "**/settings/**",
    "**/shell/**",
    "**/units/**",
    "**/time/**",
  ],
  allowTypeImports: true,
  message:
    "src/ui/ imports only src/theme/, src/format/ and src/domain/ (ADR-0022). units/ and time/ read the actor, so the caller passes the formatted string.",
};

const pureBans = {
  group: ["react", "**/ui/**"],
  allowTypeImports: true,
  message:
    "src/domain/ and src/format/ are plain functions, tested without React, and import no component (ADR-0022).",
};

// uiBans' folders and theme/, refused with domain and format's own reason.
const pureLayerBans = {
  ...uiBans,
  group: [...uiBans.group, "**/theme/**"],
  message:
    "src/format/ imports only src/domain/ and src/format/, and src/domain/ imports no other layer (ADR-0022). units/ and time/ are hooks over the actor, so the screen passes the formatted string.",
};

const domainBans = { ...pureLayerBans, group: [...pureLayerBans.group, "**/format/**"] };

const transformBans = {
  group: [
    "react",
    "**/ui/**",
    "**/api/**",
    "**/auth/**",
    "**/units/**",
    "**/time/**",
    "**/theme/**",
    "**/*.data",
    "**/*.data.*",
  ],
  allowTypeImports: true,
  message:
    "A *.view.ts is a transform: plain functions from wire shapes to what a screen shows, tested without React. It imports domain, format and other transforms; units/ and time/ read the actor, so the screen passes the formatted string (ADR-0022).",
};

// Every manager screen is on Tread, so none reaches back for the old kit.
// The Radix Select stays for the dashboard's and Exceptions' filters until
// a Tread select keeps the combobox role (TYRE-443).
const legacyBan = {
  group: [
    "**/ui/legacy/**",
    "!**/ui/legacy/Select",
    "!**/ui/legacy/Select.*",
    "!**/ui/legacy/ui.css",
  ],
  allowTypeImports: true,
  message:
    "The old kit is retired (TYRE-443). Use Tread's component in src/ui/; only the Radix Select is left in src/ui/legacy/.",
};

// Inside src/ui/ the kit is ./legacy/: a pattern matches the import's text,
// not the path it resolves to, so **/ui/legacy/** never sees it there.
const legacyBanInUi = {
  ...legacyBan,
  group: ["**/legacy/**", "!**/legacy/Select", "!**/legacy/Select.*", "!**/legacy/ui.css"],
};

// TYRE-443: the capture entry carries no manager component. The rule reads
// static imports alone, so a lazy route's import() passes. Patterns match
// as gitignore globs, which have no brace expansion, so each manager-only
// Tread file is its own entry. A file pattern also needs its `.*` twin,
// since allowImportingTsExtensions lets an import name `Metric.tsx` and the
// bare pattern does not match it.
const managerOnlyUi = [
  "Metric",
  "DataTable",
  "BandChart",
  "ProvenanceBar",
  "Tabs",
  "TabPanel",
  "Timeline",
  "KeyValue",
  "PhotoCapture",
  "PhotoGallery",
  "DamageNote",
];
const entryForbidden = {
  group: [
    "**/domain/vocabulary",
    "**/domain/vocabulary.*",
    "**/ui/legacy/**",
    "@radix-ui/*",
    ...managerOnlyUi.flatMap((name) => [`**/ui/${name}`, `**/ui/${name}.*`]),
  ],
  allowTypeImports: true,
  message:
    "The capture entry carries no manager component (TYRE-443, ADR-0009). Load it behind React.lazy in routes.tsx.",
};

const testFiles = ["**/*.test.*", "src/test/**"];

// tokens.ts is a colour's one home, and a test pins literal values on
// purpose (TYRE-27).
const colourExempt = ["src/theme/tokens.ts", ...testFiles];

const timeBans = appBans.filter((ban) => ban !== intlDateTimeFormatBan);

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
      "no-restricted-syntax": ["error", ...appBans],
      // Rule 2's web half (spec U31): see web/lint/moneyStaysString.js.
      "house/money-stays-string": "error",
      // The typescript-eslint rule below reads allowTypeImports; the core
      // rule would refuse the type imports it admits.
      "no-restricted-imports": "off",
    },
  },
  // A later block's list replaces this one for the files it matches, so the
  // last block that sets no-restricted-syntax for a file in scope includes
  // colourBans.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: colourExempt,
    rules: { "no-restricted-syntax": ["error", ...appBans, ...colourBans] },
  },
  // web/src/time/tenantTime.ts is the one legitimate home the bans above
  // point to (rule 6, TYRE-89). Only the Intl.DateTimeFormat construction it
  // needs is exempted; toLocale*, the Intl-alias ban and the number-format
  // ban still hold here (TYRE-95, U55).
  {
    files: ["src/time/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...timeBans] },
  },
  // Its source keeps the colour bans; its test pins literals as every test does.
  {
    files: ["src/time/**/*.{ts,tsx}"],
    ignores: colourExempt,
    rules: { "no-restricted-syntax": ["error", ...timeBans, ...colourBans] },
  },
  // The one class component (U54); every other ban still holds here.
  {
    files: ["src/shell/RouteErrorBoundary.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...appBans.filter((ban) => ban !== classComponentBan),
        ...colourBans,
      ],
    },
  },
  // ADR-0022's layers. Each later block replaces the list for the files it
  // matches, so the order of the next nine is part of the rule.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: testFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [dexieBan] }],
    },
  },
  // The gallery is exempt: a gallery sample formats money the way a page
  // does (TYRE-443).
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    ignores: ["src/ui/gallery/**", ...testFiles],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [dexieBan, uiBans, legacyBanInUi] },
      ],
    },
  },
  // Capture imports format/ statically, so it is entry code too.
  {
    files: ["src/format/**/*.{ts,tsx}"],
    ignores: testFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [dexieBan, pureLayerBans, pureBans, entryForbidden] },
      ],
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    ignores: testFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [dexieBan, domainBans, pureBans] },
      ],
    },
  },
  {
    files: ["src/{dashboard,fleet,admin,settings}/**/*.{ts,tsx}"],
    ignores: testFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [dexieBan, legacyBan] }],
    },
  },
  {
    files: [
      "src/{capture,driver,shell,auth}/**/*.{ts,tsx}",
      // main.tsx imports these folders statically, so each is entry code.
      // format/'s block above carries the same bans.
      "src/{theme,api,time,units}/**/*.{ts,tsx}",
      "src/App.tsx",
      "src/main.tsx",
      "src/routes.tsx",
    ],
    ignores: ["src/capture/{outbox,draft,useOutbox}.ts", ...testFiles],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [dexieBan, entryForbidden] },
      ],
    },
  },
  // The outbox and the draft are the data layer's Dexie half (ADR-0022) and
  // still sit in the entry.
  {
    files: ["src/capture/{outbox,draft,useOutbox}.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [entryForbidden] }],
    },
  },
  // Views come after the folder blocks so their list wins, and a view in an
  // entry folder keeps the entry's bans.
  {
    files: ["src/**/*.view.ts"],
    ignores: ["src/{capture,driver,shell,auth,theme,api,time,units}/**", ...testFiles],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [dexieBan, transformBans] },
      ],
    },
  },
  {
    files: ["src/{capture,driver,shell,auth,theme,api,time,units}/**/*.view.ts"],
    ignores: testFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [dexieBan, entryForbidden, transformBans] },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/api/**", ...testFiles],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Only src/api/ calls fetch. A screen reads through a query hook (ADR-0022).",
        },
      ],
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
