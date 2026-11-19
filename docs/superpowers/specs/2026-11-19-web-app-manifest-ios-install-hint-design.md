# Design: the app installs to the Home Screen (TYRE-154)

Ticket TYRE-154, as the owner decided it on 23 Sep 2026 (comment 13023) and
U169 left it (comment 14122): build the web-app manifest and a one-time
"Add to Home Screen" hint on the driver's home, and remove the
`web/vite.config.ts` comment that argues against the manifest. ADR-0009
decision 1 stands. The owner's answers of 19 Nov 2026 are under "The owner's
answers", and the browser facts this design rests on are under "Sources".

**Requirements touched, none changed:**

- SRS section 2.4, Operating environment, the capture client row: the
  capture client is installable, with a guided Home Screen step on iOS, on
  the Android and iOS versions that row names. Appendix A (PWA) and UC-01's
  precondition say the same. No row has an ID.
- IR-UI-001: one application for both interfaces, so one manifest.
- IR-UI-003, NFR-USE-004: the hint's one control takes the glove size.
- IR-UI-005: text contrast on the hint.
- NFR-USE-009: the hint is words and an icon, never colour alone.
- NFR-USE-011, FR-OFF-006, FR-OFF-020: an inspection held on the phone is
  never put at risk by the hint.
- NFR-SEC-010: the content security policy is unchanged.
- CR-006, CR-007, AS-001: what iOS lacks, one engineer, and personal phones.
- NFR-PRV-006: see "No SRS change", below.

The SRS has no row for a manifest, an app icon, the app's name on a device
or how long the hint stays. Answers of Record v1.0, Q10, lists guided "Add
to Home Screen" onboarding for iOS as a required mitigation; this ticket
builds it.

**No SRS change is prepared.** NFR-PRV-006 (with its TYRE-373 erratum)
lists what the phone holds. The hint adds one per-device flag that says the
hint was dismissed. It names no person and no tenant. The theme preference
(ADR-0020, `web/src/theme/appearance.ts:9`) is the same kind of flag and
sits outside that list today. This design follows that precedent and flags
it here for the owner.

## Intent

ADR-0009 decided an installable PWA. The app cannot be installed with its
own name and icon: `web/index.html` links no manifest, the repo holds no
icon, and nothing tells an iPhone driver to add the app to the Home Screen.
A comment in `web/vite.config.ts:43-46` argues the manifest is not needed,
which reverses an accepted ADR in a build file.

Two reasons make this more than polish:

1. **Safari clears a site's storage after seven days without a visit, and a
   Home Screen app is exempt** (Sources 1). The durable outbox (ADR-0009)
   lives in that storage. An iPhone driver who captures from a Safari tab
   holds an unsent inspection on weaker ground than one who opens the app
   from the Home Screen.
2. **Adoption.** A driver who opens the app from an icon with the product's
   name gets to "My inspections" in one tap. The brief's whole argument is
   that capture has to be easier than the paper sheet (project brief,
   sections 2 and 3).

## Goals

- Android Chrome can install the site, and the installed app opens without
  browser chrome, under the name "Tyre Track" and the app's icon.
- Chrome's own install prompt never appears over the app, so it can never
  interrupt a capture. An Android driver is offered the install on "My
  inspections" instead, by a button (section 4; the lead's proposal, put to
  the owner with this spec).
- An iPhone or iPad driver who adds the site to the Home Screen gets the
  same name and icon, and a standalone window.
- An iPhone or iPad driver on "My inspections" in a browser sees one hint
  that says how to add the app, until they dismiss it or open the app from
  the Home Screen.
- The hint never shows while the phone holds an inspection, in progress or
  waiting to send.
- The old working name "Tyre Platform" is gone from the browser tab and
  from the app bar's default.
- The contradiction between ADR-0009 and `web/vite.config.ts` is gone, and
  `web/CLAUDE.md` says what installing does.

## Non-goals

- **Written steps for Android.** Android needs no walk-through: Chrome
  hands the page an install prompt to open (section 4).
- **A way back to an inspection that no task lists.** An installed app has
  no address bar, which is the last fallback the leaver steps name
  (`docs/runbooks/provision-a-user.md:229-234`). TYRE-390's "Continue" link
  closes that, and it ships with TYRE-319, the next run in the queue
  (`docs/implementation-order.md`, row 6). The gap is accepted until then:
  a capture starts only from a task (U143), so it needs a held inspection
  whose task has gone and no other task listed. The runbook's lines stay
  true and are not edited here.
- **A service worker, a cache or a PWA plugin.** ADR-0009 and rule 7 stand.
  Chrome's install criteria list no service worker (Sources 7).
- **A favicon.** TYRE-240 carries it and reuses this ticket's mark
  (`docs/implementation-order.md`, row 8).
- **Per-tenant icons or names on the device.** The manifest is one static
  file for every tenant. IR-UI-011 covers the header only.
- **A status bar tinted with the tenant's colour.** One static
  `theme_color` cannot match every tenant's app bar, and a tag that follows
  the tenant is new entry code. The manifest carries no `theme_color`.
- **The final artwork.** The owner supplies the real icon files after this
  run (owner, 19 Nov 2026). This run commits a placeholder.
- **Renaming the repository, the Jira project, Azure resources, Go module
  or prose in the docs.** Only the two user-facing strings change (section
  5).
- **Carrying a session or a draft from Safari into the installed app.** iOS
  gives the installed app its own storage (Sources 2). The hint is hidden
  while anything is held, and its words say the driver signs in once more.
- **A settings screen to bring a dismissed hint back.** TYRE-449's screen
  is after the pilot.
- **Web push.** Out of P1 (ADR-0009 decision 4).

## Anti-goals

- No tap, screen, modal or delay inside the capture flow
  (`web/CLAUDE.md`, The capture target). The hint lives on "My inspections"
  only, and the tasks keep their place on that screen.
- No hint that tells a driver to leave an unsent inspection behind in
  Safari.
- No user-agent string parsing to decide who sees the hint.
- No lazy chunk in front of `src/driver/` (ADR-0009, the bundle check).
- No new dependency, at run time or in the build.
- No colour or font literal outside `src/theme/tokens.ts` that a test does
  not tie back to it.
- No change to the CSP, and no third-party origin for an icon.

## Constraints

- **ADR-0009.** Decision 1 is what this builds. Decision 2 and the outbox
  are untouched.
- **ADR-0015 and ADR-0020.** The hint is built from Tread components and
  tokens, in both themes. The tenant's colour reaches chrome only, so the
  hint takes no brand colour.
- **ADR-0019.** The web origin's headers come from
  `web/staticwebapp.config.json` through `scripts/write-web-config.mjs`,
  and never apply under `vite dev`. Only the production browser check and
  staging show a header or content-type fault.
- **The capture bundle ceilings** (`web/bundle-budget.json`, U200). The
  hint is in the entry, because `src/driver/` is. The PR names the import
  that grew the entry (U84). A ceiling is raised only by a hand edit with
  its reason.
- **`build.manifest: true`** (`web/vite.config.ts:68`) writes
  `dist/.vite/manifest.json` for the bundle check. It is unrelated to the
  web-app manifest and stays.
- **Copy.** Sentence case, straight quotes, no em dashes (`/unslop`). The
  driver-facing word rules in `web/src/test/spoken.ts` apply.
- **Phones are personal** (AS-001, U115). One driver per phone is the
  normal case, and the dismissal is kept per device.

## Approaches

### Where the manifest comes from

| Approach | Trade-off |
| --- | --- |
| **A static `web/public/manifest.webmanifest`, linked from `index.html`** (chosen) | Vite serves `public/` at the root in dev and copies it unhashed into `dist/` (Sources 12). No build code. Its one colour is a literal, so a test ties it to `tokens.ts`. |
| `vite-plugin-pwa` | Generates the manifest and a service worker. ADR-0009 forbids the service worker, and the plugin is a build dependency for one JSON file. Rejected. |
| A Vite plugin of ours that emits the manifest from `tokens.ts` | No literal, but build code to own and test for one colour. A test over a static file does the same job. Rejected. |

### Who sees the hint

| Approach | Trade-off |
| --- | --- |
| **Feature tests: `navigator.standalone` is defined and `navigator.maxTouchPoints > 1`, and the page is not standalone** (chosen) | `navigator.standalone` exists on Apple's WebKit alone, and the touch test tells an iPhone or iPad from a Mac, iPadOS's Mac user agent included (Sources 6). It also matches Chrome, Edge and Firefox on iOS, which can add to the Home Screen since iOS 16.4 by the same Share sheet. It matches an in-app browser too, where adding may not be offered; that driver reads a hint they cannot follow and taps "Got it". Accepted: the app's link is opened from a bookmark or a browser, and there is no reliable test for an in-app browser. |
| User-agent tokens ("iPhone", "CriOS") | Tells Safari from Chrome on iOS, which the chosen test does not need to. Breaks on iPadOS's Mac user agent and on any token change. Rejected. |
| Show the hint to everyone who is not standalone | Android and desktop users would read iOS steps. Rejected (owner: iPhone and iPad only). |

### Chrome's own install prompt on Android

Once the manifest ships, Chrome on Android may show its own "Install Tyre
Track" banner over the page. An on-device model decides when, on any page
load, the capture route included, and nothing but JavaScript turns it off
(Sources 13). The owner's first answer, iPhone and iPad only, was given on
the lead's statement that Chrome's offer sits in its menu. That statement
was incomplete, so this choice goes back to the owner with the spec.

| Approach | Trade-off |
| --- | --- |
| **Cancel Chrome's prompt on every route, and offer the install by a button on "My inspections"** (chosen, the lead's proposal) | `preventDefault()` on `beforeinstallprompt` stops the banner and keeps the event, whose `prompt()` opens Chrome's install dialog on a tap. This is the pattern Chrome documents for an app's own install offer (Sources 13). The capture flow is never interrupted, and every BAC driver, all on Android (AS-001), is offered the install at a moment that costs nothing. Cost: a listener in the entry and a second form of the hint. |
| Cancel Chrome's prompt and offer nothing | The smallest change, and the closest to the owner's first answer. An Android driver installs only from Chrome's menu, so only if the office tells them how. |
| Cancel it on the capture route only | The event fires once per page load, and this is a single-page app: a banner raised on "My inspections" can still be up when the driver taps into a capture. Rejected. |
| Leave Chrome's prompt alone | A browser banner over a capture screen, in gloves, with an "Install" button to hit by accident. It breaks the first anti-goal. Rejected. |

### Where the dismissal is kept

| Approach | Trade-off |
| --- | --- |
| **One `localStorage` key on the device** (chosen) | The pattern `appearance.ts` already uses for a per-device preference (ADR-0020). Survives sign-out, since `clearSession` removes its own two keys only (`web/src/api/token.ts:163-170`). A driver who clears site data sees the hint again, which is right. |
| A per-user setting on the server | Follows the driver across phones, but the hint is about this phone. Needs a migration and an endpoint. Rejected. |
| Component state only | The hint returns on every load. Rejected (owner: until dismissed, then never on that phone). |

### What "installed" means to the page

A page cannot ask whether the site was added to the Home Screen. It can
only tell that it is running standalone now. So the hint goes away in two
ways: the driver taps "Got it", or the page is the standalone app. A driver
who installs and later opens Safari again sees the hint there until they
dismiss it. Accepted.

## The design

### 1. The manifest and the icons

`web/public/` is new. It holds:

- `manifest.webmanifest`
- `icons/icon-192.png`, 192 by 192
- `icons/icon-512.png`, 512 by 512
- `icons/icon-maskable-512.png`, 512 by 512, the mark inside the centred
  circle whose radius is 40% of the width (Sources 8)
- `icons/apple-touch-icon.png`, 180 by 180, opaque, since iOS draws a
  transparent corner black

The manifest's members:

| Member | Value | Why |
| --- | --- | --- |
| `name` | `Tyre Track` | Owner, 19 Nov 2026. |
| `short_name` | `Tyre Track` | Ten characters, so no launcher cuts it. |
| `id` | `/` | A stable identity if `start_url` ever changes (iOS 16.4 on). |
| `start_url` | `/` | The landing route sends a driver to `/my` and a manager to the dashboard (`web/src/routes.tsx:56`). |
| `scope` | `/` | The whole origin is the app (IR-UI-001). |
| `display` | `standalone` | What makes it an app on Android and on iOS (Sources 3, 7). |
| `background_color` | Daylight's `canvas` from `tokens.ts` | Android's splash matches the first paint, which is Daylight (ADR-0020, Themes). iOS ignores it. |
| `icons` | the 192 and the 512 with no `purpose`, and the maskable 512 with `purpose: "maskable"` | Chrome needs a 192 and a 512. Separate files, never `any maskable` (Sources 8). |

No `theme_color` (Non-goals), no `orientation`, no
`prefer_related_applications`.

**The placeholder mark.** A white tyre ring on `PLATFORM_BRAND`
(`web/src/theme/tokens.ts:39`), drawn once and committed as the four PNG
files. How it is rasterised is the builder's, with no new dependency;
Playwright is already installed and can screenshot an SVG. No generator
script is committed, because the owner's files replace these.

**The owner's swap.** The real artwork replaces the four files under the
same names, with no code change. The manifest test (Testing) fails with the
file's name when a replacement has the wrong pixel size.

### 2. `web/index.html`

The head gains three tags, and the title changes:

- `<link rel="manifest" href="/manifest.webmanifest" />`
- `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />`.
  iOS prefers it to the manifest's icons (Sources 3).
- `<meta name="apple-mobile-web-app-title" content="Tyre Track" />`, the
  label iOS offers on its Add to Home Screen sheet.
- `<title>Tyre Track</title>`

The owner's 23 Sep decision named "the `apple-mobile-web-app-*` meta tags".
Two of that family are left out, as the lead's call:

- `apple-mobile-web-app-capable`: a manifest with `display: standalone` has
  done its job since iOS 11.3, and the SRS's floor is iOS 15 (Sources 3).
- `apple-mobile-web-app-status-bar-style`: its default is the behaviour
  wanted, a normal status bar with the page below it. The other value puts
  the page under the status bar, which the shells are not laid out for.

### 3. Hosting

- `web/staticwebapp.config.json` gains
  `"mimeTypes": { ".webmanifest": "application/manifest+json" }`. Azure
  Static Web Apps does not document its default for that extension, and the
  HTML standard fails a manifest fetch whose type is not a JSON type
  (Sources 10).
- The navigation fallback already excludes `*.webmanifest` and `*.png`
  (`web/staticwebapp.config.json:8`), so neither is answered with
  `index.html`.
- The CSP is unchanged. `default-src 'self'` covers a same-origin manifest
  and same-origin images (Sources 11).
- `scripts/write-web-config.mjs` copies the file's text with the API origin
  filled in, so the new key reaches `dist/` with no change to the script.
- `scripts/deploy-smoke.sh` gains one check with its stub test: the web
  origin answers `/manifest.webmanifest` with 200 and a JSON content type.
  `vite preview` applies only the config's `globalHeaders`, so the
  production browser check cannot see `mimeTypes`; the deployed origin is
  the first place it shows, and the smoke reads it on every deploy instead
  of leaving the owner a hand check.

### 4. The hint on "My inspections"

The hint has two forms, and a phone shows at most one. Both are one Tread
`Banner`, tone `info`, in the same place, under the same dismissal key and
the same "nothing held" rule.

**What an iPhone or iPad driver sees.** Written steps, with a "Got it"
button as the action:

> **Add this app to your Home Screen**
>
> Tap Share, then Add to Home Screen. If you cannot see Share, tap the menu
> button (...) first.
>
> You will sign in once more when you open it from the Home Screen.
>
> [ Got it ]

The words are the owner's approved text (19 Nov 2026). They cover Apple's
steps on iOS 18, where Share is in the bar, and on iOS 26 and later, where
Share can sit behind a menu button that Apple has already renamed once
(Sources 5). The hint names no button by Apple's label for that reason, and
draws no Apple glyph.

**Where.** In `DriverHome`, after the task lists and the trip card, as the
section's last block. The task a driver taps keeps its place whether the
hint shows or not, so the one tap between opening the app and the first
reading never moves (`web/src/driver/DriverHome.tsx:104-106`). This
placement is the lead's proposal; the owner approved the words and the
"until dismissed" rule, not the position.

**What an Android driver sees** (the lead's proposal, wording included, put
to the owner with this spec). A button that opens Chrome's own install
dialog:

> **Install this app**
>
> It opens from your Home screen like any other app.
>
> [ Install ] [ No thanks ]

"Install" calls `prompt()` on the event Chrome handed the page. If the
driver accepts in Chrome's dialog, the hint goes. If they back out of the
dialog, the hint goes for this page load and returns on a later one, since
Chrome hands over a fresh event then. "No thanks" dismisses it for good on
that phone, as "Got it" does.

**The listener.** One `beforeinstallprompt` listener is registered when the
entry loads, before any route renders, because Chrome can fire the event as
soon as the page has loaded. It calls `preventDefault()` on every route,
which is what keeps Chrome's banner away (Approaches), and keeps the event
for the hint. An `appinstalled` event drops the kept event and hides the
hint. Desktop Chrome and Edge fire the same event; cancelling it there
leaves their address-bar and menu install items in place (Sources 13).

**When a form shows.** All of these hold:

1. The device qualifies for one form:
   - the steps: `navigator.standalone` is not `undefined`, and
     `navigator.maxTouchPoints > 1`, which is an iPhone or iPad;
   - the button: the page holds a `beforeinstallprompt` event, which only
     a browser that can install the app right now sends.
2. The page is not the installed app: `navigator.standalone` is not `true`,
   and `matchMedia("(display-mode: standalone)")` does not match.
3. The hint has not been dismissed on this device.
4. The phone holds nothing: no draft, and no outbox entry, whoever
   captured it.

Condition 4 is read from the same stores the capture flow writes
(`web/src/capture/draft.ts`, `web/src/capture/useOutbox.ts`). Until both
reads have answered, the hint is not shown, so it never appears and then
vanishes. A read that fails counts as "something may be held", and the
hint stays hidden. `useOutbox` and the outbox's held count both read a
failed query as an empty outbox today, so neither serves as written: the
hint's read has to tell a failure from an empty store.

Why condition 4: iOS copies only cookies into the installed app, once, when
it is added. `localStorage` and IndexedDB are not copied (Sources 2). A
driver who installed with a draft or an unsent inspection in Safari would
open the new app, see nothing waiting, and leave that work in a tab they
no longer open, where Safari's seven-day rule still applies. The hint
appears again once the inspection has been sent. The Android form keeps
the same rule, so one rule covers both and no driver is handed an install
dialog with work in hand.

**Dismissing.** "Got it" or "No thanks" hides the hint at once and writes one
`localStorage` key, named like its neighbours (`tyre.appearance`,
`tyre.auth.subject`); `tyre.install-hint` is the working name. A store that
cannot be read counts as not dismissed. A store that cannot be written
keeps the dismissal for the page's life, as `writeAppearance` does
(`web/src/theme/appearance.ts:28-35`). Sign-out does not clear the key.

**Accessibility.** `Banner` at tone `info` is a `role="status"` region. Each
button is a Tread `Button` at the glove size, and neither takes the brand
colour's primary look away from a screen that has its own primary action.
After a dismissal the buttons are gone, so focus moves to the page heading,
which needs `tabIndex={-1}` for that, or to another sensible target the
builder chooses; it must not fall to the document body.

**The module boundary.** The decision (conditions 1 to 4, the stored flag
and the kept event) is a small module with the browser objects passed in,
as `appearance.ts` takes its `Storage`, so vitest can drive every case
without a real phone. The component only renders what that module decides.

### 5. The name

"Tyre Platform" was a working title. The product is "Tyre Track" (owner, 19
Nov 2026). Two user-facing strings change, with the tests that pin them:

- `web/index.html:6`, the browser tab title.
- `web/src/theme/ThemeProvider.tsx:16`, the display name the app bar shows
  before a tenant's branding is known.

The comment above that constant says the API serves the same default. It
does not: `orgBranding` falls back to the tenant's registered name
(`api/internal/httpapi/tenant.go:106-134`). The comment is corrected in the
same commit, since the branch touches the line it describes.

Nothing else is renamed (Non-goals). `scripts/deploy-smoke.test.sh:97` and
`:180` use the old title inside their own fixture pages and stay, unless
the builder finds a check that reads the real title.

### 6. Docs and comments

- `web/vite.config.ts:43-46`: the sentence about an installable manifest
  goes. The rest of the comment, why there is no service worker and no PWA
  plugin, stays true and stays.
- `web/CLAUDE.md`, The network: one bullet saying the app installs from a
  static manifest with no service worker, that the installed iOS app has
  its own storage, and that the hint is hidden while anything is held. The
  conventions list notes that a file under `web/public/` ships unhashed at
  the site root.
- ADR-0009 gains a dated amendment: decision 1 is now built (TYRE-154); the
  installed iOS app's storage is separate from Safari's, so installing
  means one more sign-in; and the product's name. No new ADR: this builds a
  decision already recorded.

## Testing

**Vitest**

- The decision module, one case per row: iPhone in a browser with nothing
  held (shown); standalone by either signal (hidden); a Mac, where
  `standalone` is defined and `maxTouchPoints` is 0 (hidden); Android or
  desktop Chrome with no kept event, where `standalone` is undefined
  (hidden); dismissed (hidden); a draft held (hidden); an outbox entry held
  (hidden); a held read still pending (hidden); a held read that failed
  (hidden); a store that throws on read (shown) and on write (hidden for
  the page's life). For the Android form: a kept event with nothing held
  (the button shows); an event on an iPhone-shaped device (one form only);
  "Install" calls `prompt()` once, and an accepted choice hides the hint
  while a backed-out one hides it without writing the key; `appinstalled`
  hides it.
- The listener: it cancels the event on every route, the capture route
  included, and an event that fires before "My inspections" mounts still
  reaches the hint.
- `DriverHome`: the hint is the last block; "Got it" and "No thanks" each
  remove it and write the key; a second render with the key set shows
  none; focus does not land on the body; the existing task and trip cases
  still pass with the hint present.
- The manifest: it parses; its members equal section 1's table;
  `background_color` equals Daylight's `canvas` in `tokens.ts`; every icon
  it names exists under `web/public/` and its PNG header carries the
  declared size; the apple-touch icon is 180 by 180. A failure names the
  file.
- `index.html`: the three tags and the title.
- `web/src/test/spoken.ts` covers the hint's words, as it covers every
  driver screen.

**The production browser check** (`web/e2e/production.spec.ts`, the built
bundle under the deploy's headers): `/manifest.webmanifest` answers 200 as
JSON that parses, not as `index.html`; each icon the manifest and
`index.html` name answers 200 as a PNG; a signed-in load of "My
inspections" still reports no CSP violation.

**The dev-stack browser tests** (`web/e2e/`, the `ios` project). One case
stubs `navigator.standalone` and the touch count before load, since
Playwright's WebKit is not iOS Safari and does not define the property off
a Mac: the hint shows on "My inspections", "Got it" removes it, and a
reload keeps it gone. One case on the `android` project dispatches a
synthetic `beforeinstallprompt` with a stub `prompt()`: the button shows,
and "No thanks" removes it for good. `capture.spec.ts` and `reach.spec.ts`
must pass unchanged.

**The deploy smoke's stub test** (`scripts/deploy-smoke.test.sh`): the new
manifest check passes on a JSON content type and fails on another type and
on a 404.

**What no test here can prove.** That a real phone installs the app, shows
the name and icon, and completes sign-in inside the installed app; that
Chrome's own banner stays away on a real Android phone; and that Chrome
hands the page its event without a service worker, which its source says
and its older documents deny (Sources 7, 13). On iOS the provider's page
opens in an in-app Safari view and should close itself when the redirect
returns (Sources 9), and the last known breakage was fixed in iOS 16.4.
Those checks are the owner's, on staging, after the merge (Definition of
done).

## Definition of done

1. `web/public/` holds the manifest and the four placeholder icons, and
   `web/index.html` links them and carries the new title.
2. `web/staticwebapp.config.json` sets the manifest's content type, and
   the deploy smoke checks it.
3. The hint, in both forms, shows, hides and dismisses as section 4 says,
   and Chrome's own prompt is cancelled on every route.
4. The two "Tyre Platform" strings read "Tyre Track".
5. The `web/vite.config.ts` comment no longer argues against the manifest,
   `web/CLAUDE.md` describes installing, and ADR-0009 carries its
   amendment.
6. The tests under Testing exist and pass, and `make check` passes.
7. The capture bundle stays under its ceilings, or a ceiling is raised by
   hand with its reason, and the PR names the import that grew the entry.

Owed by the owner after the merge, and listed at hand-over:

- Replace the four placeholder icon files with the real artwork.
- On staging, on a real iPhone: the hint shows in Safari; Add to Home
  Screen gives the "Tyre Track" name and the icon; the app opens without
  Safari's bars; sign-in completes inside it; the hint is gone there.
- On staging, on an Android phone: "My inspections" shows "Install this
  app", and "Install" opens Chrome's dialog; the installed app opens
  without browser bars and sign-in completes; no Chrome banner appears
  during a capture. If the button never shows, Chrome's menu still offers
  "Add to Home screen", and the finding goes on the ticket.

## The owner's answers (19 Nov 2026)

| Question | Answer |
| --- | --- |
| Who supplies the icon | The owner has the icons and supplies them the next day; a placeholder until then. |
| The app's name | "Tyre Track" under the icon and as the full name. |
| The old name in the tab and the app bar default | Renamed here. |
| Who sees the hint | iPhone and iPad only. Given before the Chrome finding under Approaches; the Android button is put back to the owner with this spec. |
| How long it shows, and its words | Until dismissed or opened from the Home Screen; the iPhone words in section 4. |

## Lead's calls

| Question | Choice | Source |
| --- | --- | --- |
| Manifest source | A static file in `web/public/`, no plugin | Sources 12; ADR-0009 |
| Service worker | None | Sources 7 |
| Manifest members | Section 1's table; no `theme_color` | Sources 3, 7 |
| Icon set | 192, 512, a separate maskable 512, a 180 apple-touch icon | Sources 3, 7, 8 |
| Apple tags | The touch icon and the title; no `capable`, no status bar style | Sources 3 |
| Content type | `mimeTypes` in the Static Web Apps config | Sources 10 |
| CSP | Unchanged | Sources 11 |
| Who is an iPhone or iPad | `navigator.standalone` defined and more than one touch point | Sources 6 |
| Chrome's own prompt | Cancelled on every route; the install offered by a button (the owner's to confirm) | Sources 13 |
| The content type on the deployed origin | One check in the deploy smoke | `scripts/deploy-smoke.sh:1-14` |
| The gap until TYRE-390 ships | Accepted; the next run carries it | `docs/implementation-order.md:98` |
| Hidden while anything is held | Yes, for both forms, and hidden while unknown | Sources 2 |
| Where the dismissal lives | One `localStorage` key, kept through sign-out | `web/src/theme/appearance.ts:9`; `web/src/api/token.ts:163-170` |
| Hint position | Last block on "My inspections" (the owner may move it) | `web/src/driver/DriverHome.tsx:104-106` |
| ADR | An amendment to ADR-0009, no new record | `docs/adr/0009-client-platform-and-on-device-data.md:41` |
| SRS | No change; the NFR-PRV-006 point flagged above | ADR-0020, Themes |

## Left to the builder

- File and symbol names for the hint component and its decision module,
  and the final name of the storage key.
- How the hint learns that a draft exists: a one-off read on mount or a
  live query, as long as the hint is hidden until the answer is in.
- How the placeholder PNGs are produced, with no new dependency.
- Where focus goes after "Got it".
- The hint's spacing and any CSS, from Tread's tokens.
- Whether the manifest and `index.html` tests live in one file or two.
- The exact wording of the docs lines in section 6.

## Sources

Read on 19 Nov 2026.

1. Safari's seven-day cap and the Home Screen exemption:
   https://webkit.org/tracking-prevention/ and
   https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/
2. The installed app's own storage, cookies copied once since iOS 17.2:
   https://webkit.org/blog/14787/webkit-features-in-safari-17-2/ and
   https://webkit.org/blog/14403/updates-to-storage-policy/
3. What iOS honours from a manifest and from Apple's tags:
   https://github.com/mdn/browser-compat-data/tree/main/manifests/webapp ,
   https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/ ,
   https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
   and
   https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html
4. iOS 26 opens every Home Screen site as a web app:
   https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
5. Apple's steps, by iOS version:
   https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/18.0/ios/18.0 ,
   https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/26.0/ios/26.0
   and
   https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27.0/ios/27.0
6. Detecting the device and the standalone window:
   https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Navigator.idl ,
   https://webkit.org/blog/9674/new-webkit-features-in-safari-13/ ,
   https://developer.mozilla.org/en-US/docs/Web/API/Navigator/maxTouchPoints
   and
   https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/
7. Chrome's install criteria and its own install UI:
   https://web.dev/articles/install-criteria ,
   https://developer.chrome.com/blog/update-install-criteria and
   https://developer.chrome.com/blog/mini-infobar-update
8. Maskable icons: https://web.dev/articles/maskable-icon
9. A sign-in redirect inside an installed app:
   https://web.dev/learn/pwa/windows ,
   https://developer.chrome.com/docs/capabilities/scope-extensions and
   https://bugs.webkit.org/show_bug.cgi?id=249967
10. The manifest's content type:
    https://html.spec.whatwg.org/multipage/links.html#link-type-manifest ,
    https://www.w3.org/TR/appmanifest/ and
    https://learn.microsoft.com/en-us/azure/static-web-apps/configuration
11. CSP fallback for a manifest:
    https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/manifest-src
12. Vite's `public/` directory and its build manifest:
    https://vite.dev/guide/assets and https://vite.dev/config/build-options
13. Chrome's own install prompt on Android, and cancelling it. Chromium
    source at `main`, `components/webapps/browser/banners/app_banner_manager.cc`
    (the prompt is shown only when the event was not cancelled, and the site
    is marked installable before the event fires) and
    `components/webapps/browser/features.cc` (the model-driven prompt, on by
    default on Android):
    https://chromium.googlesource.com/chromium/src/+/main/components/webapps/browser/ ;
    a Chrome engineer on its launch, 13 Feb 2026:
    https://lists.w3.org/Archives/Public/public-webapps/2026JanMar/0015.html ;
    https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event ;
    the app's own install offer: https://web.dev/articles/customize-install
