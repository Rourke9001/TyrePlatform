# The colour gate, read by parsers: stylelint for CSS, eslint selectors for TSX

Date: 2026-11-12. Ticket: TYRE-475 (epic TYRE-443). Status: awaiting the
owner's approval. From the 9 Nov 2026 design audit, section 5 (verdict
Replace); the owner approved replacing the gate on 9 Nov (ticket). The
ticket cites no SRS requirement; this is build tooling, no product code.
It reverses no ruling. It reads one by its reason and not its letter,
the refusal of a data: URL in a stylesheet (#151 round 7), and puts that
reading to the owner with this spec (The CSS half).

## Intent

A colour reaches a component only through a custom property that
`web/src/theme/tokens.ts` defines (TYRE-27, TYRE-445, `web/CLAUDE.md`).
`scripts/check-colour-literals.mjs` holds that rule by running regular
expressions over raw CSS and TS text. It has 11 commits, 8 of them fixes,
and #151's stage 5 rounds 3 to 8 each found a hole the last patch opened
(ticket, The problem). `docs/lessons.md:196-210` names this gate and says
what to do: put every case in the test first, then make one change that
reads the text the way its consumer does.

The browser reads CSS with a CSS parser and the compiler reads TSX with a
TypeScript parser. This design gives the rule to two tools that already
do that. stylelint's core rules read the stylesheets. eslint's
`no-restricted-syntax`, which `web/eslint.config.js` already uses for
seven bans, reads the components. The script and its two call sites go.

The rule itself does not change. What changes is which text each half
refuses at the edges, and the section "What changes for a file" lists
every such case.

## What the spec-stage reading showed

The lead ran both tools over the self-test's cases before writing this.
The scripts and their output are in
`.superpowers/sdd/2026-11-12-pipeline-TYRE-475/probes/` (gitignored), and
the results that shape the design are below.

- **stylelint 17.16.0 is the version that installs today.** 18.0.0 is the
  registry's latest, published 3 Nov 2026, so `min-release-age=14`
  (`web/.npmrc:9`) refuses it until 17 Nov. 17.16.0 was published 1 Oct
  2026 (`npm view stylelint time`).
- **The ticket's "it uses the postcss already installed" is wrong.**
  17.16.0 depends on `postcss ^8.5.26` and the lockfile holds 8.5.25. A
  dry run of the install in `web/` adds 83 packages and moves three:
  postcss to 8.5.32, nanoid to 3.3.20 and source-map-js to 1.2.2. Vite
  builds with that postcss. `scripts/check-release-age.mjs`, run over the
  probe's lockfile, passes: the youngest package is `ansi-regex@6.5.0` at
  14.0 days and postcss 8.5.32 is 16.7 days old.
- **The ticket's rule list misses three cases the gate refuses today.**
  With exactly the ticket's rules (`stylelint-ticket-rules.out`):
  - `function-url-scheme-disallowed-list` reads `url()` in a
    declaration. It does not see a bare string in `image-set()` or
    `-webkit-image-set()`, which are two of the self-test's wanted lines
    (`scripts/check-colour-literals.mjs:266-267, 310-311`).
  - It does not read an at-rule's parameters. `@import url("data:...")`
    passes. `import-notation: "url"` refuses `@import "data:..."` only
    for its notation, and refuses a plain `@import "./plain.css"` the
    same way. The ticket's line "so an `@import` data: URL reaches the
    scheme rule" does not hold.
  - `function-disallowed-list` matches a string entry by case, so
    `RGB(0 0 0)` passes. Today's gate is case-insensitive in CSS
    (`:61-64`).
- **Three changes close them, each a core rule that reads the parsed
  stylesheet** (`stylelint-final-rules.out`): a case-insensitive pattern
  in `function-disallowed-list`, the same rule refusing `image-set()`,
  `-webkit-image-set()` and `image()` whole, and
  `at-rule-disallowed-list` for `@import` in place of `import-notation`.
  With those, every CSS line the self-test wants is refused, every file
  it wants quiet is quiet, and `content: "Red"` and `grid-area: tan`
  pass. No stylesheet in `web/src` uses any of the three functions or
  `@import`.
- **`color-named: "never"` passes `transparent` and `currentColor`, and
  `color-no-hex` passes `url(#fade)` and `url("#bead")`.** Both were the
  ticket's "to confirm".
- **`web/src` is clean under both halves.** stylelint over the 56
  stylesheets finds nothing, in 0.7 seconds. The candidate eslint
  selectors over 419 TS and TSX files find colour only in
  `src/theme/tokens.ts`.
- **eslint's selector engine takes what the TSX half needs:** the `i`
  flag, a lookbehind, `:matches()` and a descendant combinator
  (`eslint-cases.out`). A `/` cannot appear inside a selector's regex, so
  the candidate writes it `\x2f`.
- **One unanchored hex pattern cannot do what the ticket asks.** The
  ticket wants a hex on every `Literal` refused, and wants `"Order
  #1234"` and `href="/vehicles#cafe"` to pass. Text alone cannot tell
  `"Order #1234"` from `"solid #1234"`. The design splits by position
  instead (The TSX half).
- **CI's colour step sits in the `comments` job**, which checks out the
  repo and installs nothing (`.github/workflows/ci.yml:114-132`).
  stylelint needs `npm ci`, so "today's slot" does not exist for it in
  CI.
- **`web/lint/` already proves lint rules by linting planted text
  through the real config** (`web/lint/legacyImports.test.ts:11-18`,
  under vitest). `prettier --check .`, `eslint .`, `tsc -p
  tsconfig.e2e.json` and the comment check would all read a fixture
  directory of real `.css` and `.tsx` files.
- **`no-restricted-syntax` is set by three blocks today:** the main block
  for `**/*.{ts,tsx}`, `src/time/**` and
  `src/shell/RouteErrorBoundary.tsx` (`web/eslint.config.js:246, 261,
  268`). A later block's list replaces an earlier one's.
  `src/time/tenantTime.test.tsx` uses `Intl.DateTimeFormat`, so a test
  exemption that reset the list to `appBans` would turn that file red.
- **stylelint's Node API reads the config for planted text.**
  `stylelint.lint({ code, codeFilename })` finds `stylelint.config.mjs`
  by itself, a rule's `message` option replaces its text, `ignoreDisables:
  true` makes an inline `stylelint-disable` do nothing, and a glob that
  matches no file is an error, not a pass.

## Goals

1. Every case in The planted cases lands as that section lists it. That
   list is the contract. It carries every case of today's self-test with
   today's result, and "What changes for a file" lists the differences
   known when this was written and the rule that judges one found later.
2. The text the gate refuses today that holds no colour passes: the
   ticket's four cases and the regex-literal hole.
3. A parser reads each file. No code in the repo finds a CSS declaration,
   a comment or a string by regular expression for this gate.
4. The planted cases prove both halves through the real configs, and
   compare exact findings, as the self-test does today.
5. `make lint` and CI run the same two commands. The script and its call
   sites are gone.

## Non-goals

- The cases today's gate does not cover, which stay uncovered (ticket):
  `el.style.setProperty("color", "red")`, a computed custom-property key,
  a colour held in a constant and applied later, and the contents of a
  base64 data: URL.
- `web/index.html`, `web/e2e/`, `web/lint/` and the config files. The
  gate scans `web/src` today (`scripts/check-colour-literals.mjs:332`)
  and keeps that scope.
- Any other stylelint rule. No shared config such as
  `stylelint-config-standard`, no formatting rule, no plugin. The config
  holds the colour gate and nothing else.
- stylelint 18. Renovate raises it once it is old enough.
- An ADR. The rule and its one home stand (ADR-0015, TYRE-27); this
  changes the tool that reads for it, on a ticket the owner approved.
- The font half of `web/CLAUDE.md`'s "a hex or font literal in a
  component is a bug". No gate checks it today.

## Anti-goals

- A custom stylelint plugin or a custom eslint rule that walks text. That
  is the scanner again in a new file.
- A fixture of real `.css` and `.tsx` files that four other gates must
  each be told to skip.
- A self-test that passes on a non-zero exit alone. The old one compares
  the exact list (`scripts/check-colour-literals.mjs:284-318`), and so
  does the new one.
- A file that loses a ban it has today because its block's list was
  replaced.
- A rule switched off inline in a stylesheet.

## The design

### 1. The CSS half

`web/stylelint.config.mjs`, with `ignoreDisables: true` and these core
rules, each with a `message` that names the remedy as today's message
does (read the token's custom property, `web/CLAUDE.md`, TYRE-27):

| Rule | Setting | Refuses |
| --- | --- | --- |
| `color-no-hex` | `true` | a hex colour in a value |
| `color-named` | `"never"` | a named colour in a value, in any case |
| `function-disallowed-list` | case-insensitive patterns for `rgb`, `rgba`, `hsl`, `hsla`, `oklch`, `oklab`, `lab`, `lch`, `hwb` and `color`, and for `image-set`, `-webkit-image-set` and `image` | the colour functions, today's list (`:26`), with `color-mix()` still allowed; and the three functions that take a URL as a bare string |
| `function-url-scheme-disallowed-list` | `["data"]` | `url(data:...)` in a declaration, quoted or not, in any case |
| `at-rule-disallowed-list` | `["import"]` | the one at-rule that loads a URL from its parameters, which no rule above reads |

That is five rules, and each reads stylelint's parsed tree. The ticket's
`declaration-property-value-disallowed-list` is not used: the only way it
closes the bare-string case is a regular expression over a declaration's
raw value, which is the scanner's method again (Goals, 3).

`npm run lint:css` is `stylelint "src/**/*.css"`. A JS config, not the
ticket's `.stylelintrc.json`, because JSON holds no comment and the last
three rows each need their reason and ID beside them (CLAUDE.md,
Comments), and because the patterns are regular expressions.

No stylesheet is exempt. Today's exemption for test paths
(`:80-87`) has no stylesheet to apply to: none sits under `src/test/` or
is named `*.test.*`.

**The data: rule is "no data: URL that the browser would load".** The
owner approved "refusing a data: URL in a stylesheet", and the reason on
record is that the CSP blocks an image, a font or an imported stylesheet
from one (`.superpowers/sdd/2026-10-29-review-pr151/report-7.md:45-51`,
gitignored; `scripts/check-colour-literals.mjs:73-75`; ADR-0019). This
design holds the ruling to that reason. Whether it may is the owner's to
say, and the approval message asks. The
browser loads a URL from `url()` in a declaration, from the bare string
`image-set()`, `-webkit-image-set()` and `image()` take, and from
`@import`. So `@import` and the three functions are refused whole, with
or without a data: URL. No stylesheet in `web/src` has any of them, the
app loads each stylesheet by a TS import, and no core rule reads an
at-rule's parameters or a function's bare string for a scheme. Text that
spells `data:` where nothing loads it passes: a selector such as
`a[href^="data:"]`, an `@supports` condition, an `@namespace` and a
`content` string. Today's gate refuses those four by matching the text
(`:76, 124`).

### 2. The TSX half

A list `colourBans` in `web/eslint.config.js`, beside `appBans`, of
`no-restricted-syntax` entries. A "string" below is a `Literal`'s value
or a `TemplateElement`'s raw text.

1. **A string that is a hex colour and nothing else**, anywhere. `"#fff"`
   is refused. `"Order #1234"` and `"/vehicles#cafe"` pass.
2. **A string that holds a colour function's opening**, anywhere, for the
   same ten names as the CSS half, case-sensitive as today (`:66`).
3. **A string under a style context that holds a hex colour**, not
   counting `url(#id)`.
4. **A string under a style context that holds a named colour**, in any
   case, with today's word boundaries (`:57`), so `"green-ish"` and
   `"./red.svg"` pass.

A hex colour has 3, 4, 6 or 8 hex digits
(https://www.w3.org/TR/css-color-4/#hex-notation). Today's pattern takes
3 to 8.

A style context is any node below one of these, at any depth, whose name
matches today's key list (`:70-71`: `color`, `fill`, `stroke`,
`stopColor`, `floodColor`, `lightingColor`, `background*`, `border*`,
`outline*`, `boxShadow`, `textShadow`, `caretColor`, `accentColor`,
`textDecorationColor`, `columnRuleColor`):

- an object property with that key, `{ color: ... }`;
- a JSX attribute with that name, `<path fill=... />`;
- an assignment to a member or a variable with that name,
  `el.style.color = ...`, `color = ...`;
- a variable or a parameter default with that name, `const fill = ...`,
  `function f(color = ...)`;
- a class field with that name, `fill = ...`.

A computed key is not a name: `{ [color]: "red" }` is not a style
context, and passes today.

Today's 40-character window matches `key:` or `key=` before a string.
These are the shapes of that text that hold a value. Two shapes of it
are left out. A type by itself is not a style context: a type member,
`type T = { color: "red" | "blue" }`, and a parameter's type,
`function f(color: "red")`, are refused today and pass after, because a
type is erased and paints nothing, and a value of that type is still a
string under one of the shapes above. And text that only looks like a
key is not one: in `on ? color : "red"` the window reads the ternary's
colon as a key's. Every string below a style context counts, whatever it
is, so a type written inside one, `const fill: "white" = x`, is still
refused, as today. Depth is what the ticket asks for: `color: on ?
"red" : "blue"` is refused.

Each entry's message names the remedy, as in the CSS half.

**Scope.** `colourBans` applies to `src/**/*.{ts,tsx}` except
`src/theme/tokens.ts` and the test files (`testFiles`,
`web/eslint.config.js:215`), which is today's scope and exemption
(`:80-87, 332`). The invariant for the blocks: every file keeps exactly
the `appBans` entries it has today, and gains `colourBans` if and only if
it is in scope. So `src/time/tenantTime.ts` and
`src/shell/RouteErrorBoundary.tsx` gain the colour bans and keep their
one exemption each, and `src/time/tenantTime.test.tsx` gains nothing and
keeps its `Intl.DateTimeFormat` exemption.

### 3. The planted cases

The TYRE-49 self-test becomes a vitest file in `web/lint/`, in the house
pattern (`web/lint/legacyImports.test.ts`): planted text, linted through
the real config, never a file on disk. The ticket's "planted fixture
directory" is this.

- **CSS** goes through `stylelint.lint({ code, codeFilename })` with a
  `codeFilename` under `src/`, so `web/stylelint.config.mjs` is the
  config under test.
- **TSX** goes through `new ESLint({ cwd })` and `lintText(code, {
  filePath })`, so `web/eslint.config.js` is the config under test. The
  type-aware parser needs a `filePath` that exists
  (`web/lint/legacyImports.test.ts:9-10`).

It carries, and compares as an exact list of line and rule (CSS) or line
and ban (TSX):

1. Every planted file from the self-test (`:163-283`), with the same
   text. The 21 CSS lines and 7 TSX lines of its `want` list (`:284-313`)
   are refused, and every file it wants quiet is quiet: `quiet.css`,
   `Quiet.tsx`, `keywords.css`, `Words.tsx`, `anchors.css`, `paths.css`,
   `fonts.css`, `clean.tsx`.
2. The exemptions, with red text at an exempt path: `src/theme/tokens.ts`
   and a test file are quiet.
3. The ticket's cases. Refused: a hex after a regex literal that holds
   `//`, and both arms of `color: on ? "red" : "blue"`. Quiet: `"Order
   #1234"`, `href="/vehicles#cafe"`, `content: "Red"`, `grid-area: tan`.
4. The cases the spec-stage reading and the builder check added. Refused
   in CSS: `RGB(0 0 0)`, `@import url("data:...")`, `@import
   "./plain.css"`, `image-set()` holding only `url(./a.png)`, `image()`
   with a bare string, a hex and a named colour in a custom property's
   value, a named colour inside `color-mix()`, and a data: URL in
   `URL("...")`, in `url( "..." )` with spaces, in `Url(DATA:...)` and
   in a `url(` that breaks the line before its string. Quiet in CSS:
   `content: "#fff"`, `content: "rgb("`, `content: "data:"`,
   `url(./a.svg#fff)`, `url( #fade )`, `a[href^="data:"]`, an
   `@supports` condition that holds a data: URL, and an `@namespace`
   with one. Refused in TSX: `"#fff"` alone, a hex inside a longer
   string under a style key, `<stop stopColor="red" />`,
   `el.style.color = "red"`, `color = "red"`, `const fill = "white"`,
   `const fill: "white" = x`, a parameter default, a class field. Quiet
   in TSX: `fill="none"`, `stroke="currentColor"`, `color:
   "transparent"`, a `var(--ink)` value, a hex inside a longer string
   outside a style context, a type member `color: "red" | "blue"`, a
   parameter's type `color: "red"`, `on ? color : "red"`, a computed key
   `{ [color]: "red" }`, and a class field `label = "Red"`.
5. The block invariant, at real paths: `src/time/tenantTime.ts` refuses a
   planted colour, still allows `Intl.DateTimeFormat` and still refuses
   `toLocaleString`; `src/time/tenantTime.test.tsx` refuses no colour and
   still allows `Intl.DateTimeFormat`; `src/shell/RouteErrorBoundary.tsx`
   refuses a planted colour and still allows its class; a file under
   `e2e/` refuses no colour.
6. An inline `stylelint-disable` comment over a planted colour, which is
   still refused.

**Order of work.** stylelint is installed first, with a config that
holds no rule, and `colourBans` starts empty. The planted cases are then
written and shown red for the right reason: each wanted finding is
missing, and nothing fails on a missing module or config. Then the
configs make them green. The
script goes last, after `npm run lint:css` and `npm run lint` are green
on the tree. Before it goes, the implementer plants one literal in a real
stylesheet and one in a real component under `web/src`, sees `make lint`
fail on each from the new commands, and removes both. That shows the two
commands reach the tree; the vitest file shows the configs refuse the
right text. The PR body records it.

### 4. `make lint` and CI

- **Makefile.** `npm run lint:css` joins the `cd web && ...` line after
  `npm run lint`. The two `check-colour-literals.mjs` lines go
  (`Makefile:418-419`). The `lint` target's help text says stylelint
  where it says colour literals.
- **CI.** `npm run lint:css` follows `npm run lint` in the Frontend
  job's step (`.github/workflows/ci.yml:263`), which has run `npm ci`.
  The "Colour literals outside tokens.ts" step leaves the `comments` job
  (`:128-132`). Same commands as `make lint`, in the same order.
- **Where the proof runs.** The planted cases run with `npm test`, in
  `make test` and in the Frontend job, as the other `web/lint/` tests do.
  `make lint` no longer runs a colour self-test of its own. The money
  gate's web half already works this way (`Makefile:403-405`).
- **An empty run is red.** stylelint fails when its glob matches no file,
  so `lint:css` does not pass `--allow-empty-input`.

### 5. Deletes and docs

- `scripts/check-colour-literals.mjs` is deleted.
- `CLAUDE.md:130`, the `make lint` line: "colour literals" becomes
  stylelint, as the ticket says.
- `web/package.json` gains `stylelint` in `devDependencies`, written as
  its neighbours are, and the `lint:css` script. `web/package-lock.json`
  is regenerated by `npm install` under `web/.npmrc`.
- No other doc names the script. `web/CLAUDE.md`'s "a hex or font literal
  in a component is a bug", ADR-0015 and
  `web/src/ui/gallery/photos.gallery.tsx:7` describe the rule, not the
  tool, and stay as they are. `docs/lessons.md:196-210` is history and
  stays.

## What changes for a file

These are the differences known when this was written. The table is not
a proof that there are no others: today's gate matches text, and text
has more shapes than a short read finds. A difference found later is
judged by one rule. A string is refused when it names a colour and sits
where the code or the stylesheet uses it as a value: in a stylesheet, a
declaration's value outside a string; in a component, alone as a hex,
holding a colour function, or below a style context. A data: URL is
refused where the browser would load it. Anything else the old gate
refused, it refused by coincidence of text, and passing it is not a
regression. A case the rule refuses and the new gate passes is a bug in
this branch, unless Non-goals or the table names it.

| Case | Today | After | Why |
| --- | --- | --- | --- |
| A hex after a regex literal that holds `//`, in TS | passes | refused | ticket; the comment stripper is gone |
| `"Order #1234"`, `href="/vehicles#cafe"` | refused | pass | ticket; a hex inside a longer string counts only under a style context |
| `content: "Red"`, `grid-area: tan`, and any named colour in a CSS string or a non-colour identifier | refused | pass | ticket; stylelint reads the value's tokens |
| A hex or a colour function's name inside a CSS string, `content: "#fff"`, `content: "rgb("` | refused | pass | the same reading; a string paints nothing |
| A hex-shaped fragment after a path, `url(./a.svg#fff)` | refused | passes | it names an element in the file, as `url(#fade)` does |
| `data:` spelled where nothing loads it: `a[href^="data:"]`, an `@supports` condition, an `@namespace`, `content: "data:"` | refused | **pass** | The CSS half, the data: rule |
| `image-set()`, `-webkit-image-set()` or `image()` with no data: URL in it | passes | **refused** | refused whole, as `@import` is; the tree has none |
| A type member or a parameter's type under a style key, `type T = { color: "red" }`, `function f(color: "red")` | refused | passes | a type paints nothing |
| Text that only looks like a key, `on ? color : "red"` | refused | passes | the ternary's colon is not a key's |
| A named colour under a style key but past 40 characters or behind an expression, `color: on ? "red" : "blue"` | passes | refused | ticket; the tree has no window |
| A hex inside a longer string outside a style context, `const s = "0 0 0 1px #abcdef"` | refused | **passes** | the price of the row above it; it is the ticket's "colour held in a constant and applied later" |
| A TS string of `#` and 5 or 7 hex digits | refused | passes | not a colour in CSS |
| A plain `@import` in a stylesheet | passes | **refused** | no core rule reads an at-rule's parameters; the tree has none |
| An inline `eslint-disable` over a colour ban | no such thing | possible | true of every eslint ban today; it shows in the diff |
| `href="#add"`, a whole string that reads as a hex | refused | refused | unchanged; the id is renamed, as today |

## Lead's calls

1. **No product question went to the owner before this spec.** The ticket
   settles what is replaced and with what, and nothing here changes what
   a user sees.
2. **stylelint 17.16.0**, the newest version `min-release-age=14` admits
   (`web/.npmrc:9`; `npm view stylelint time`: 18.0.0 on 2026-11-03,
   17.16.0 on 2026-10-01). Its transitives clear the window
   (`scripts/check-release-age.mjs` over the probe's lockfile).
3. **postcss moves from 8.5.25 to 8.5.32**, against the ticket's "it uses
   the postcss already installed" (`npm view stylelint@17.16.0
   dependencies`: `postcss ^8.5.26`; the dry run in `web/`). Vite builds
   with it, so `make check` and CI's build, bundle and browser jobs are
   the proof that nothing moved.
4. **`at-rule-disallowed-list: ["import"]` replaces the ticket's
   `import-notation`.** The scheme rule does not read at-rule parameters
   (`probes/stylelint-ticket-rules.out`: `probes.css:3` is not refused),
   so the ticket's rule would let `@import url("data:...")` through and
   keep the owner's data: ruling only by accident of notation.
5. **`image-set()`, `-webkit-image-set()` and `image()` are refused
   whole**, and the ticket's `declaration-property-value-disallowed-list`
   is not used (`probes/stylelint-final-rules.out`, `data.css:10-11`,
   `builder.css:7-10`). The first draft of this spec closed the
   bare-string case with a pattern over the raw value; the builder check
   pointed out that this is a regular expression finding a string, which
   Goals, 3 rules out.
6. **The colour functions are one case-insensitive pattern**
   (`probes/stylelint-ticket-rules.out`: `RGB(` passes a string entry).
7. **`stylelint.config.mjs`, not `.stylelintrc.json`** (The CSS half).
   stylelint finds it without a flag (probe, 12 Nov).
8. **`ignoreDisables: true`.** Today's gate cannot be switched off in a
   stylesheet, and this keeps that
   (`node_modules/stylelint/types/stylelint/index.d.ts:176-178`; probe).
   eslint has no per-rule equivalent: `noInlineConfig` would also void
   the two `react-hooks` disables in `src/capture/PositionSheet.tsx:93,
   143`. An inline disable of `no-restricted-syntax` is as possible for
   colour as it is for rule 6's date bans today, and a reviewer sees it.
9. **A whole-string hex anywhere, an embedded hex only under a style
   context** (What the spec-stage reading showed). It gives up the
   embedded hex in a string that no style key names. The other choice,
   today's, refuses `"Order #1234"`, which the ticket calls a bug.
10. **The style context is every shape of today's `key:` or `key=` text
    that holds a value, read from the tree**, wider than the ticket's "a
    style key, or a `fill`, `stroke` or `color` JSX attribute".
    Narrowing to the ticket's words would let `<stop stopColor="red" />`
    and `el.style.color = "red"` through, which today's gate refuses
    (`:70-71`), and the charts are inline SVG (ADR-0015). A type member
    and a parameter's type are left out, and a computed key is not a
    name (`probes/eslint-cases-2.out`, `probes/eslint-cases-3.out`).
11. **Planted text in a vitest file, not a fixture directory** (The
    planted cases; `web/lint/legacyImports.test.ts:11-18`). A directory
    of real files would need a skip in prettier, eslint, the e2e tsconfig
    and stylelint itself, and prettier would reflow the multi-line
    `box-shadow` case the self-test pins by line (`:244-247`).
12. **In CI the command moves to the Frontend job** (`ci.yml:114-132,
    253-270`). The ticket's "in today's slot" holds in the Makefile's
    sense, the same gate in the same run, not the same job.
13. **`colourBans` is its own list, not entries in `appBans`** as the
    ticket has it. `appBans` reaches `**/*.{ts,tsx}`, which would put the
    colour bans on `e2e/`, the config files and the vitest file that
    plants the cases (`web/eslint.config.js:220, 246`).
14. **No ADR** (Non-goals).
15. **From the builder check** (three questions, all settled here). The
    style context gained the bare assignment and the class field and
    names the type member as given up (call 10). The bare-string data:
    case moved from a pattern to a whole-function refusal (call 5). The
    table "What changes for a file" gained the CSS rows the check found,
    and stopped claiming to be complete: the planted cases are the
    contract and the table carries the rule for a difference found later
    (`docs/lessons.md`, 2026-11-06, a general claim is tested outside
    the reviewer's examples or narrowed). One row reads the owner's
    data: ruling by its reason, a URL the browser would load, and not by
    its letter, so it is put to the owner with this spec.

## Rejected

- **The ticket's rules as written.** Three wanted cases pass (What the
  spec-stage reading showed).
- **A small stylelint plugin for at-rule parameters.** It would let a
  plain `@import` through, which nothing needs, at the cost of
  hand-written matching in the gate again.
- **A value pattern for a quoted string that starts `data:`.** It closes
  `image-set("data:...")` and keeps a plain `image-set()` legal, but it
  is a regular expression over a raw value with a lookbehind for
  `url(`, the kind of match rounds 3 to 8 of #151 kept patching.
- **`postcss` and a script of our own.** A parser, but the rules would be
  ours to write and patch. stylelint's are maintained and tested
  upstream.
- **A custom eslint rule in `web/lint/`, as `moneyStaysString` is.** It
  could exempt `href` and merge the four entries into one, but the
  selectors already carry every wanted case (`probes/eslint-cases.out`),
  and the ticket asks for selectors.
- **`linterOptions.noInlineConfig`.** It voids two disables the tree
  needs.
- **Waiting for stylelint 18.** Five days, for a major version nine days
  old, and the five rules used here are all in 17.

## Constraints

- `min-release-age=14` and `scripts/check-release-age.mjs` gate the
  lockfile (`make lint`'s `npm-release-age-check`, and CI). `ansi-regex@6.5.0`
  was 14.0 days old on 12 Nov, so a resolve on the same day may pick the
  version below it; either passes.
- The install is `npm install` in `web/`, never an edit of the lockfile,
  and never with `min-release-age-exclude` (`web/.npmrc:11-17`).
- The capture bundle's ceilings (`web/bundle-budget.json`, TYRE-474) are
  checked by `make lint`. A devDependency ships nothing, but postcss
  writes the CSS, so the CSS figure is the one to watch.
- A selector's regex cannot hold `/` (probe). The named-colour boundary
  class has one (`:57`).
- `tsconfig.e2e.json` includes `lint/`, so the vitest file typechecks
  under `npm run typecheck`. stylelint ships its own types.
- This PR's diff touches `ci.yml` and the lockfile, so a red CI job on it
  cannot use the "touches no file in the diff" re-run unless it ended
  `cancelled` or `timed_out` (`.claude/commands/pipeline.md`, Hand-over
  step 4).
- `scripts/check-workflow-timeouts.mjs` and `actionlint` run over the
  workflow (`make infra-lint`). No job is added.
- The implementer is a teammate: it runs gates in the foreground, does
  not push, and dispatches no subagent.
- Comments and messages follow `docs/comments.md`. A rule's `message` is
  a user-facing string.

## What is left to the builder

- The exact regular expressions and selector strings, how the named
  colours are listed (stylelint needs no list; the TSX half does), and
  whether the four TSX entries are four or are merged.
- The wording of each message, as long as it names the remedy.
- How the eslint blocks are arranged to hold the invariant in The TSX
  half.
- The vitest file's name and layout, and which real paths stand in for
  each planted file.
- Whether `stylelint` is written with a caret, as most neighbours are.
- The commit order inside "Order of work", as long as the planted cases
  are committed red-first evidence in the PR body and the script's
  deletion is the last code change.

## Acceptance

- `scripts/check-colour-literals.mjs` does not exist, and
  `rg -n --hidden -g '!.git' "check-colour-literals" .` finds the name
  only in this spec.
- `cd web && npm run lint:css` and `npm run lint` are green on the tree.
- The planted cases in `web/lint/` pass under `npm test` and cover items
  1 to 6 of The planted cases, comparing exact lists.
- The PR body records the two planted-literal runs of `make lint`, each
  red from the new command, and the red-first run of the planted cases.
- `make lint` and the Frontend job run `npm run lint:css` after `npm run
  lint`; the `comments` job has no colour step.
- `web/stylelint.config.mjs` holds the five rules of The CSS half and
  `ignoreDisables: true`, and no other rule.
- `node scripts/check-release-age.mjs` passes on the new lockfile.
- `CLAUDE.md`'s `make lint` line names stylelint.
- `make check` is green, and the capture bundle's three figures are
  under their ceilings.
