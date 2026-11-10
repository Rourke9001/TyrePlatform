# Design: the token store reads the library's session (TYRE-471)

Ticket TYRE-471, from the 9 Nov 2026 design audit, section 1. U199 (9 Nov
2026) applies, with the owner's answer of 10 Nov 2026 recorded below.

**Requirements touched, none changed:**
- FR-AUT-001, FR-AUT-015 and FR-AUT-016, as TYRE-373 amends them.
- NFR-PRV-006, as amended. Its notice names the sign-in tokens and the
  driver stamp, not where in storage they sit.
- FR-OFF-014, unchanged.

## Intent

Sign-in should follow the documented pattern for a browser app, and depart
from it only where a project rule forces it.

**The pattern.** The sign-in library keeps the session. Before each API call
the app asks it for a token, which it returns from its cache or renews. Only
a refusal sends the user to sign in again. Microsoft documents this for MSAL
as `acquireTokenSilent`, followed by an interactive request only on
`InteractionRequiredAuthError`
(https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-acquire-token).

**What the app does instead.** It keeps a second copy of the session in its
own `localStorage` key, beside the library's.
- Its one reason was that `token.ts` sat in the entry while `oidc.ts` was a
  lazy chunk the entry could not await (b9 spec
  `docs/superpowers/specs/2026-09-30-b9-sign-in-design.md:551-557`).
- U175 put the library in the entry on 4 Nov, and the copy stayed.
- About 35 fixes on this mechanism since 1 Oct kept the two copies in step:
  `held`, the callback's unwind, `mirrorRenewed`'s tenant carry and
  `sameDriver`'s discard.

**The stalled renewal.** A renewal whose response body stalls holds the
one-renewal lock for the life of the page, so every later call fails at once
until a reload (`web/src/api/token.ts:218-232`; b9 spec `:597-606`). An
installed iOS PWA has no reload control. U199 abandons such a renewal at its
bound instead.

## The standard, each departure, and what to do with it

The owner's direction of 10 Nov 2026: an owner ruling that makes the
implementation harder, or drifts from standard practice, is to be
overwritten, amended or deleted rather than built around. Each row below is
a rule this design rests on.

| The standard pattern | This design | The rule behind any difference | Recommendation |
| --- | --- | --- | --- |
| The library keeps the session | Same | None | Keep |
| The app asks for a token before each call: cached if live, renewed if not | Same (`credential()`) | None | Keep |
| Renewal on demand, not on a timer, as MSAL does | Same | None. oidc-client-ts defaults to a timer (`automaticSilentRenew`), set off so renewal is the store's decision (`web/src/auth/oidc.ts:86-88`) | Keep |
| Only a refusal sends the user to sign in | Same | U199 with Q1 (owner, 10 Nov 2026) | Keep |
| The library's default store, `sessionStorage` | `localStorage`, through the library's documented `userStore` setting | U102: a phone empties `sessionStorage` whenever it closes the browser, so drivers would need an emailed code on most cold starts (`web/src/auth/oidc.ts:83-84`; b9 spec `:538-549`) | Keep |
| The auth library loads with the app | Same | U175 | Keep |
| On a personal device, whoever is signed in owns the session and its queued work | A stored session serves only the last driver whose sign-in passed the stamp compare, and someone else's sign-in is undone while one driver's work is held | U104 and U111 B, written for shared phones. U115 (8 Oct 2026) found phones are personally owned and kept the undo | Keep (see below) |
| The library's request timeout bounds its requests | The app fetches discovery under `deadline()`, and each library call is bounded by its caller | The library's timeout ends when the headers arrive (`docs/lessons.md:604`) | Keep. A fix upstream (authts) would remove it; filing that is the owner's call |
| A 401 is retried after a renewal | A 401 on a token obtained under 60 s ago stops the store for the page | b9 spec, "A fresh token refused": a misconfigured API refuses every token, and renewing again cannot help | Keep. It costs one comparison in memory here |
| Cached branding is per tenant | The tenant id is kept for the first paint | b9 spec, Cached state: one company's brand must not paint for the next driver | Keep |

**U104 and U111 B.** These are the one real departure.

- **What they do.** They hold back a phone's queued inspections until the
  driver who captured them signs in. They undo a sign-in by anyone else,
  ending that person's Entra session. They refuse sign-out while work is
  held. They stamp every draft and outbox row with the capturing driver
  (PD-S3; b9 spec, The outbox and the driver stamp).
- **The standard they come from.** Shared devices carry these safeguards
  (SAP's offline SDK, Apple's Shared iPad). On a personally owned phone the
  standard is the single-user model.
- **They were already weighed against personal phones.**
  - U115 (owner, 8 Oct 2026, TYRE-392 comment 13477) found that drivers do
    not share phones. It closed the shared-phone work, and kept the U104
    undo for the rare second account: "nothing is lost and nothing sends
    under the wrong driver".
  - ADR-0016 decision 8 accepts the rare cases: a rehire with a new
    account, or a borrowed or reissued phone. The b9 spec's 5 Nov rider
    (`:929-934`) says the same.
- **What they cost in this ticket.**
  - One comparison when a stored session is read.
  - The subject check in `sameDriver`.
  - The last row of "The four late settles".
- **What retiring them would touch.** Mostly outside this ticket: the
  outbox stamps and their Dexie version, the draft-start refusal, the
  callback's compare and undo, the waiting-driver message, and sign-out's
  refusal.
- **The subject key would stay without them.** The clean-up after a
  sign-out (rows 2 and 3 of "The four late settles") reads the cleared
  subject key to know a sign-out happened.
- **Recommendation.** Keep them, with no new ticket. U115 already decided
  the undo earns its cost for the borrowed-phone case, and this ticket's
  share of it is one comparison.

## Goals

- One copy of the tokens: the library's stored user. No app code reads or
  writes a token from a key of its own.
- `credential()` with a live token never waits on the network.
- Discovery is fetched once per page under `deadline()`, which bounds the
  body, and handed to the library as `metadata`. The library's own network
  requests are then only the code exchange and the refresh POST.
- A renewal past its bound is abandoned (U199). The next call starts a new
  one. A renewal that settles late can never remove a session that a later
  renewal or sign-in restored.
- Behaviour a driver sees does not change, except that a stalled renewal no
  longer needs a reload.

## Non-goals

- Filing the library's `_useRefreshToken` timeout spread upstream with
  authts. It is outward-facing and waits for the owner.
- Changing U104's behaviour, the outbox, sign-out's PD-S3 guard or the
  sign-in screens (see the U104 note above).
- react-oidc-context, a service worker, or any change to token lifetimes,
  scopes or Entra settings.
- Fetching discovery ahead of need.

## Anti-goals

- App code that reads the library's storage key or format. Reads go through
  `getUser()`. Test code may plant a user in it (Tests, below).
- A second store the app reads a token from, in storage or in memory.
  - The store keeps two access-token strings in memory, and only to compare
    against: the last token it obtained and the last one refused (Sending,
    below).
  - It never sends a token it did not just read from the library.
- An app `await` placed inside one of the library's call sequences.

## Constraints

- **U102.** The session survives an app restart: `localStorage`, 24 hours
  at most.
- **U104, U111 B.** Only the redirect callback changes the last-known
  subject (`tyre.auth.subject`). A session whose subject differs from it is
  never used.
- **U175.** `oidc.ts` is the only file that imports oidc-client-ts, and it
  stays in the entry's static closure (`scripts/check-capture-bundle.mjs`).
- **U199, with Q1 (owner, 10 Nov 2026, answer A).** A renewal past its bound
  is abandoned, and the next call retries it.
  - Only a refusal from the identity provider lapses the session.
  - A timeout reads as no signal every time. The outbox holds, "Sync now"
    retries, no sign-in prompt shows, and the stored session is kept.
  - This matches the b9 spec's "Renewal fails for want of a network", and
    MSAL's samples, which go interactive only on
    `InteractionRequiredAuthError`.
- **TYRE-388.** The redirect callback's discovery and code exchange share
  one `REQUEST_TIMEOUT_SECONDS` budget (`web/src/auth/callback.ts:79-85`).
- **Sign-out order** (b9 spec, Signing out, 4 Nov rider). The stored user is
  removed before the first request that can fail.

## The token store

This section is the authority for the token store from this change on. The
b9 spec's section of the same name is superseded by a rider (Other wording,
below). The bold subsection names match the old ones, so a code comment's
"Renewal" or "A fresh token refused" still finds its rule. Comments in the
files this change touches cite this spec.

**The session.** The library's stored user, in `localStorage` (U102), is the
one copy of the tokens. `web/src/api/token.ts`, in the entry, reads it
through `getUser()` before each call, as MSAL's `acquireTokenSilent` does. It
never reads the library's storage format. It keeps only what the library has
no notion of, each in its own key:

- **The last-known subject** (`tyre.auth.subject`): the `oid` of the last
  driver whose sign-in passed the U104 compare.
  - Only the redirect callback writes it, and only `signOut()` clears it.
  - So it survives a 401 (b9 spec, The outbox and the driver stamp).
- **The branding tenant** (`tyre.auth.tenant`): the tenant `GET /api/me`
  proved, read for the branding cache key at first paint (b9 spec, Cached
  state).
  - `fetchMe()` writes it, and only while the last-known subject is still
    the one its call was sent under, so a late answer for the previous
    driver never lands on a new sign-in's key. *(Amended after review 0,
    F2.)*
  - Every sign-in and `signOut()` remove it.

**The old key.** A phone signed in before this change still holds
`tyre.auth.mirror`: an access token, the driver's `oid` and the tenant id.
Nothing else would remove it, so the store removes it once per page load,
and `signOut()` removes it too. Nothing reads it. This is the one place the
key's name stays in the code.

**Which stored user serves a call.**
- A stored user is used only when its `oid` equals the last-known subject.
- The token and the subject a call sends come from that one user.
- A user whose `oid` differs is never used. It counts as not usable, like
  an expired one, so the store renews it. The renewal's own subject check
  (A renewal for another driver, below) removes it if the subject still
  differs when the renewal settles.
  - It is not removed at read time. The library stores a new sign-in's user
    before the callback writes the subject, and a removal at read time
    would race another tab's sign-in.
  - The callback writes the subject with nothing awaited after the library
    stores the user, only microtasks (The redirect callback). A renewal
    settles only after a network round trip, so by then the subject is
    written. Its removal is conditional, so it removes nothing it did not
    store. *(Amended after review 0, F4: the U104 stamp read used to sit
    between the two, so a renewal could settle inside it.)*
  - This is also what clears a lasting mismatch: a page closed between the
    library's write and the subject's. Today does the same, by renewing
    whenever the copy is unusable (`web/src/api/token.ts:242-248`).
- The ID token carries the person's `oid` through the `profile` scope. The
  client never decodes the access token.

**Expiry.** A token counts as expired 60 seconds before `expires_at`, so none
expires in flight.

**Discovery.**
- The identity provider's discovery document is fetched once per page, on
  first need, under `deadline()`, which bounds the body as well as the
  headers (`web/src/api/deadline.ts`).
- It is handed to the library as `metadata`. The library's own requests are
  then only the code exchange and the refresh POST.
- A manager with no metadata serves storage reads, so a live token never
  waits on discovery.
- A failed discovery is not kept. The next call fetches again.

**Renewal.** With no usable token and no last-known subject there is no
session to renew, because every sign-in writes the subject or does not
finish. The call throws `ApiError(401, code "signed_out")`. Otherwise the
store renews:

- **One attempt at a time, up to its bound.**
  - Concurrent callers share one renewal, bounded at
    `REQUEST_TIMEOUT_SECONDS`.
  - The one-renewal lock is released when the bound settles, not when the
    library does.
- **A stalled renewal is abandoned (U199).**
  - Past the bound the caller gets a plain `Error`, which the outbox and
    the queries read as no signal. The next call starts a fresh renewal.
  - A timeout never lapses the session, however often it recurs. Only a
    refusal does (owner, 10 Nov 2026).
  - The retry can send the same refresh token. Entra does not revoke one
    when it is redeemed
    (https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens,
    Token lifetime: "doesn't revoke old refresh tokens when used to fetch
    new access tokens").
- **A late settle removes only its own.** An abandoned renewal runs on in
  the library, which stores what it gets. So every removal a renewal makes
  is conditional:
  - a refused refresh token removes the stored user only if it still holds
    that refresh token;
  - a renewal for another driver, or one that settles after a sign-out,
    removes the stored user only if it still holds the access token that
    renewal obtained.

  One case remains. A renewal that settles in one tab after a different
  driver has signed in in another tab overwrites that sign-in, and the new
  driver signs in once more.
- **No refresh token stored.**
  - The renewal ends as a lapse without calling `signinSilent`, and removes
    the stored user. A session that cannot renew is over, and its ID token
    names the person (b9 spec, section 6).
  - Without this check the library would fall back to a hidden iframe on
    `/`.
  - The user is read once before discovery and once after it, because
    another tab's sign-out can remove it meanwhile.
- **The identity provider refuses the refresh token.**
  - Any `ErrorResponse` except the provider's transient codes counts,
    including `invalid_grant` once the 24-hour refresh token has lapsed.
  - The stored user is removed, so nothing outlives the session (U102).
  - The call throws `ApiError(401, code "signed_out")` without touching the
    API.
- **A renewal for another driver (U111 B, TYRE-396).**
  - Only the redirect callback changes the last-known subject.
  - A renewal whose subject differs from it means a stored session never
    passed the U104 compare. That includes one that settles after a
    sign-out cleared it.
  - Its user is removed and the renewal is a lapse, so the next sign-in
    runs the compare as usual.
- **Renewal fails for want of a network, a timeout included.** The call
  throws the network error, the outbox reads it as offline, and the app does
  not claim the driver is signed out.

**A fresh token refused.** A token the store obtained less than 60 seconds
earlier, by a renewal or a sign-in in this page, may be refused with 401.
Then the API is misconfigured: a wrong `AUTH_AUDIENCE`, `AUTH_CLIENT_ID` or
scope name gives every valid token a 401, and renewing again cannot help.
The token store then:

- stops renewing for the rest of the page load;
- logs the fact once;
- makes every call throw `ApiError(503, code "auth_unavailable")` without
  touching the API.

`ActorState.failure` becomes `'unavailable'`, and the outbox reads 503 as
retryable. The lock and the time each token was obtained live in the page's
memory, so a reload clears both.

**Sending.** `send()` in `web/src/api/client.ts` attaches
`Authorization: Bearer`. On a 401 that is not a fresh token's:
- the store marks that token refused, in memory;
- the next call renews instead of sending it again;
- only that token is marked, so a slow 401 for an older token leaves a
  since-renewed one alone;
- the library's stored user is not removed, since its refresh token still
  renews;
- when the refused token is still the stored user's, the store starts its
  one renewal at once, through `renewOnce`, so U199's bound and the late
  settles hold. The library's user is replaced before a reload could send
  the refused token again. *(Amended after review 0, F1.)*

**The redirect callback.** Before the exchange, it reads the driver stamps
of the work held on the phone (U104). The library then stores the new user.
Then, with nothing awaited between, in this order and before anything calls
the API:
1. the U104 compare, against the stamps read before the exchange;
2. the branding tenant key is removed;
3. the last-known subject is written;
4. the access token is recorded as obtained now, so the fresh-token lock
   covers a sign-in.

If step 2 or 3 throws, the stored user is removed if it still holds this
sign-in's access token, and the sign-in reports "did not finish". An exchange
that finishes past the bound is removed only if the stored user still holds
its access token.

**Signing out.** `signOut()` clears the last-known subject, the branding
tenant key, every `tyre.branding.*` key and the store's memory. It reads the
stored user's ID token for `id_token_hint`, then removes the stored user.
Only after that does it wait on discovery and redirect.

## How the pieces fit

### Two `UserManager`s over one store

The library reads `settings.metadata` once, in the `MetadataService`
constructor (installed esm
`web/node_modules/oidc-client-ts/dist/esm/oidc-client-ts.js:855-858`). So a
manager that is to make no discovery request must be built after discovery
has answered. Storage needs only the authority and the client id (esm
`:3522-3546`).

- **The reader.**
  - Built from `VITE_AUTH_*` on first use, with no metadata.
  - Used only for `getUser()` and `removeUser()`, which touch storage and
    make no request.
  - `credential()` uses it, so a live token never waits on discovery.
- **The network manager.**
  - Built once per page, from the same settings plus the fetched
    `metadata`.
  - Makes every call that reaches the identity provider: `signinRedirect`,
    `signinRedirectCallback`, `signinSilent`, `signoutRedirect`.

Both share the one `WebStorageStateStore` over `localStorage`, which holds no
copy in memory (esm `:946-960`), so a write by one is the next read of the
other. Neither raises an event the app listens to.

### Discovery

- **The URL.** It is the reader's `settings.metadataUrl` (public,
  `dist/types/oidc-client-ts.d.ts:666`; built from the authority at esm
  `:1032-1041`), so the app does not restate the library's rule.
- **The bound.** One `deadline("sign-in discovery")` covers the fetch and
  its body (`web/src/api/deadline.ts:13-26`).
- **A bad answer.** A non-2xx status, a body that is not JSON, or one
  without string `issuer`, `authorization_endpoint` and `token_endpoint` is
  a plain `Error`, which reads as no signal.
- **Memoised on success only.** A failed or timed-out discovery is
  forgotten. Memoising the rejection would rebuild the stuck promise U199
  removes.
- **The test seam.** `createAuth`'s `metadata` setting stays, so a test
  builds the network manager with no fetch.

### The four late settles

A renewal abandoned at its bound runs on in the library, which stores its
renewed user itself (`_useRefreshToken`, esm `:3156-3163`).
- So "ignore it" in the app cannot undo its write.
- Its clean-up is still needed, because `sameDriver`'s discard is what
  removes a session stored after a sign-out (b9 spec `:617-623`).
- So each removal is conditional (Renewal, above).

For an abandoned renewal R1 of driver S that settles late:

| Meanwhile | R1 late success | R1 late refusal | `credential()` then |
| --- | --- | --- | --- |
| A retry succeeded | The library overwrites the retry's user with R1's, both valid for S. `sameDriver` keeps it | Its removal finds a different refresh token stored and removes nothing | S's live token |
| This tab's sign-out rejected, page stayed | R1's user is stored. The subject is gone, so `sameDriver` removes R1's own user | Nothing stored to remove | Signed out, store empty |
| Another tab signed out | As the row above | As the row above | Signed out, store empty |
| Another driver B signed in, in another tab | R1's user overwrites B's. S is not the subject, so `sameDriver` removes R1's own user. B signs in again once | Its removal finds B's refresh token and removes nothing | Signed out for B once, then B's own session |

One more case: the retry was refused, so the stored user was removed and
the driver was shown the sign-in prompt. Then R1 succeeds late. The library
stores R1's user, S is still the subject, and `sameDriver` keeps it. The next
call finds a live token and the prompt goes. This is accepted: the identity
provider honoured that refresh token, so the session is a real one.

The last row's success case happens today too: a renewal that settles in one
tab after another driver's sign-in in another discards that sign-in
(`web/src/api/token.ts:208-216`). It needs two tabs, and a renewal left
running from before a second driver signed in on the same phone. It is
accepted.

### What is deleted, and what stays

**Deleted.**
- In `web/src/api/token.ts`: `MIRROR_KEY`, `Mirror`, `isMirror`,
  `readMirror`, `writeMirror`, `clearMirror`, `held`, `mirrorRenewed`, and
  the two-store compare in `refused`.
- In `web/src/auth/oidc.ts`: `discovered()` and its three call sites.
- In `web/src/auth/callback.ts:102-124`: the copy's write and its clear.
  The subject write and its failure path stay (The redirect callback,
  above).
- The mirror fixtures in the 11 files that plant one. The ticket says 24;
  `rg -il mirror` over `web/src` and `web/e2e` finds these 11:
  - nine unit test files: `api/client`, `api/token`, `auth/AuthGate`,
    `auth/callback`, `auth/callback.stall`, `auth/oidc`, `capture/outbox`,
    `capture/outbox.flush` and `theme/ThemeProvider`;
  - `e2e/idp.ts` and `e2e/auth.spec.ts`.
- Tests whose only subject is the copy: the copy and the library diverging,
  `held` under a store that refuses writes, and `rememberTenant`'s merge.
  Their case cannot occur with one store. Each deletion names that reason in
  its commit.

**Changed, not deleted.** `rememberTenant` now writes the tenant key.

**Stays.** `deadline.ts`, `bounded()`, `renewOnce`, `sameDriver`, the latch,
`SUBJECT_KEY`, `OTHER_DRIVER_KEY`, `BRANDING_PREFIX`, `refreshable()`,
`TRANSIENT_CODES` and the redirect callback's U104 compare.

## Other wording this changes

The implementer makes these edits; the owner approves the words here.

**The b9 spec.** One rider goes directly above its "### The token store"
heading (`:563`). The body is not rewritten.

> *Superseded 10 Nov 2026 by TYRE-471. From here to "The redirect callback"
> the authority is `docs/superpowers/specs/2026-11-10-library-session-store-design.md`,
> The token store.*
>
> - *The store keeps no copy of the access token. Wherever this spec says
>   "the mirror", read the library's stored user.*
> - *Where it says a 401 clears the mirror, read that the store marks that
>   token refused.*
> - *The tenant for the branding key comes from its own key.*
> - *A renewal past its bound is abandoned (U199), not held.*
> - *The second auth-chunk rider below (4 Nov) is superseded the same way:
>   the app fetches discovery once per page.*

**ADR-0016.** Decision 7 gains, after "(in the entry since 2026-11-04, see
the amendment below)": "*, and since 2026-11-10 the library's stored user is
the only copy (second amendment)*". A new section follows the 2026-11-04
amendment:

> ## Amendment, 2026-11-10 (TYRE-471, U199)
>
> Decision 7's client keeps one copy of the session, the library's stored
> user. The token store reads it before each call and renews on demand. This
> is the pattern MSAL documents for single-page apps: `acquireTokenSilent`,
> then an interactive request only when interaction is required. The store's
> own copy in a separate key existed only because the library was a lazy
> chunk the entry could not await, and the amendment above ended that.
>
> - **What the app adds.** The last-known subject (U104, U111 B): a stored
>   session is used only when its `oid` matches it. The tenant for the
>   branding cache key. The fresh-token lock, held in the page's memory.
> - **Discovery** is fetched once per page under the app's own deadline,
>   which bounds the body, and passed to the library as `metadata`.
> - **A renewal past its bound is abandoned (U199).** The next call starts a
>   new one, because Entra does not revoke a refresh token when it is
>   redeemed. A timeout reads as no signal; only a refusal lapses the
>   session.
> - **Rejected.** Keeping the copy: every fix to it had to keep two stores
>   in step. react-oidc-context: it wraps the same `UserManager` in a React
>   provider, and `send()` and the outbox run outside React.

**`web/CLAUDE.md`, Sign-in.** The first sentence, "`src/api/token.ts` is the
token store and sits in the entry: it reads a mirror of the access token from
its own `localStorage` key, never the library's storage format.", becomes:

> `src/api/token.ts` is the token store and sits in the entry: it reads the
> library's stored user through `getUser()` before each call, and keeps only
> the last-known subject (U104) and the branding tenant in keys of its own
> (TYRE-471).

**The header at `web/src/api/token.ts:1-3`** becomes:

> The session the API sees (ADR-0016, U102). The library's stored user is
> the one copy of the tokens; this store decides when to renew and which
> driver a stored session may serve (U104).

**Every other comment that names the copy** is rewritten to say what is now
true, for example `web/src/auth/me.ts:24` ("The mirror keeps it for the
branding cache key") and `web/src/capture/outbox.ts:247`. A comment the code
proves false is a bug (CLAUDE.md).

## Tests

The nine stall tests are kept as the regression set:

| Test | After this change |
| --- | --- |
| `oidc.stall.test.ts:134`: signIn rejects on a stalled discovery body | Kept; the stall is now in the app's discovery fetch |
| `:146`: signOut rejects after clearing the local session | Kept |
| `:160`: signOut removes the stored user when discovery cannot be fetched | Kept |
| `:177`: renew rejects on a stalled discovery before any token is sent | Kept; re-aimed at the one discovery site |
| `:194`: renew answers null with no iframe when the user goes during discovery | Kept; re-aimed at the read after discovery |
| `:212`: the redirect itself is not bounded | Kept |
| `callback.stall.test.ts:60`: the app renders signed out past the bound | Kept |
| `:83`: an exchange finishing past the bound is discarded | Kept; also asserts the removal depends on its access token |
| `:101`: nothing is discarded when the exchange fails outright | Kept |

New tests, each shown failing first:

- A renewal whose refresh POST body stalls rejects at the bound, and the
  next `credential()` starts a second renewal (U199).
- A timeout two and three times in a row never sets the lapse and never
  removes the stored user (Q1).
- Each row of "The four late settles", with the store's content and what
  `credential()` returns after it.
- A failed discovery is fetched again on the next call; a successful one is
  fetched once per page.
- `credential()` with a live token makes no request.
- A stored user whose `oid` is not the last-known subject is never used.
  The store renews it, and the renewal removes it only if the subject still
  differs when it settles. A callback that writes the subject while that
  renewal is in flight keeps its user.
- The old `tyre.auth.mirror` key is removed at load and at sign-out.
- On 401s:
  - a 401 on an unexpired token that is not fresh renews at once, and a
    reload after it serves the renewed token *(amended after review 0,
    F1)*;
  - a 401 on a fresh one latches;
  - a slow 401 for an older token leaves the renewed one alone.
- The branding tenant key is written by `fetchMe`, removed at sign-in and at
  sign-out, and read at first paint.

Unit tests plant a session as a library user through one helper beside
`src/test/bearerSession.ts`, which writes `new User({...}).toStorageString()`
under the library's key. No test file plants one by hand.

## Lead's calls

- **Two managers: a reader with no metadata, and a network manager built
  after discovery.**
  - Why: the library reads `metadata` only at construction (esm
    `:855-858`), and storage needs only the authority and client id (esm
    `:3522-3546`).
  - Rejected: waiting for discovery before every read, which would put the
    identity provider in front of every API call.
  - Rejected: assigning the library's private metadata cache, which reaches
    into its internals.
- **Conditional removal instead of ignoring an abandoned renewal.**
  - The library stores the renewed user itself (esm `:3156-3163`), so
    ignoring the result in the app undoes nothing.
  - `sameDriver`'s discard is the sign-out clean-up (b9 spec `:617-623`).
  - Comparing on the refresh token for a refusal, and on the access token
    otherwise, is right in all four late settles (How the pieces fit).
- **A mismatched `oid` is renewed, not removed at read time.**
  - The library stores a sign-in's user before the callback writes the
    subject (`web/src/auth/callback.ts:82-110`), so a removal at read time
    would race another tab's sign-in.
  - Leaving it unrenewed would strand a phone whose page closed inside that
    window. The phone would show the sign-in prompt over another person's
    stored session, or read as offline, and nothing would clear it.
  - Renewing it matches today (`web/src/api/token.ts:242-248`). The
    renewal's subject check runs when it settles, after a network round
    trip, and its removal is conditional.
- **The old `tyre.auth.mirror` key is removed once per page load, with no
  seeding of the tenant key from it.**
  - Phones signed in on staging or production before this change keep it.
    Every remover of it is deleted (`web/src/api/token.ts:57-63`, `:167-171`),
    and it names the driver, against U102 and b9 spec section 6.
  - Seeding the tenant key would save one platform-brand first paint per
    phone, once, which is not worth a reader of the old format.
- **A 401 marks the token in memory and starts a renewal at once.**
  - `refused()` is called synchronously (`web/src/api/client.ts:70`).
  - Removing the library's user would turn a silent renewal into a full
    sign-in, and the b9 spec keeps the silent one (`:664-668`).
  - A reload forgets the mark. The first call after a reload is the gate's
    `GET /api/me`, which is not retried on a 401
    (`web/src/api/apiError.ts:19-27`), so the sign-in screen would show
    (`web/src/auth/AuthGate.tsx:16`) though the refresh token renews. The
    renewal at once replaces the library's user first, and it goes through
    `renewOnce`, so it is the store's one renewal.
  - *(Amended after review 0, F1: this call first said the next 401 after
    a reload would renew.)*
- **The U104 stamp read comes before the sign-in exchange.**
  - From the library's `storeUser` to the callback's subject write there is
    then nothing but microtasks: the library raises `userLoaded` with no
    handler (`monitorSession` and `automaticSilentRenew` are off,
    `web/src/auth/oidc.ts:115-116`; esm `:3319-3333`, `:2731-2736`), its
    `localStorage` store is synchronous (esm `:3535-3541`), and `bounded()`
    is a `Promise.race` (`web/src/api/deadline.ts`).
  - So no other tab's renewal can settle between the two, and the claim in
    Which stored user serves a call holds by construction.
  - Cost: work stamped under another driver in another tab during the
    exchange no longer undoes the sign-in. The send guard still compares
    each entry's stamp before any send (`web/src/capture/outbox.ts:247-249`),
    and phones are personal (U115).
  - Rejected: a "sign-in finishing" marker in storage, a second cross-tab
    key built to protect the same discard (U204).
  - *(Added after review 0, F4.)*
- **The fresh-token lock and the obtained times live in memory.** The lock
  is already page-scoped (b9 spec `:642`).
- **The branding tenant gets its own key, rather than only the `/api/me`
  fallback.**
  - The fallback alone would paint the platform brand on every cold start
    until `/api/me` answers (`web/src/theme/ThemeProvider.tsx:21-28`).
  - Clearing the key at every sign-in matches today, where a sign-in writes
    the tenant as null (`web/src/auth/callback.ts:103-109`).
- **A store that refuses the renewed user's write stays as today.**
  - The library rejects `signinSilent` when it cannot store the user (esm
    `:3535-3541`, `:3161`), so the renewal fails as no signal, before and
    after this change.
  - `held` covered only the library's write succeeding and the copy's
    failing (`web/src/api/token.ts:181-203`), which one store cannot do.
- **The b9 spec gets a rider, not a rewrite.**
  - A dated spec is a record that code comments cite. The b9 spec's own
    riders already supersede that way (`:644`, `:692`).
  - This follows the standard for decision records: "keep the old one
    around, but mark it as superseded"
    (https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
  - The ADR change is an amendment section, following ADR-0016's own
    precedent (`docs/adr/0016-identity-provider-and-token-to-actor.md:183`).
- **Q1's answer has a primary source.** MSAL's samples go interactive only on
  `InteractionRequiredAuthError`
  (https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-acquire-token,
  "Acquire a token with a pop-up window").
- **An accepted residual: the iframe window.**
  - Between the store's read after discovery and `signinSilent`'s own read
    (esm `:3110-3112`) there is no network wait, only microtasks.
  - Another tab's sign-out landing exactly there would start the library's
    iframe on `/`.
  - Closing it would need the library's private refresh method.
  - Before this change, the window was a full discovery round-trip wide.

## Left to the builder

- Function names and file layout inside `oidc.ts` and `token.ts`, provided
  `oidc.ts` stays the one importer of oidc-client-ts.
- How the e2e helpers in `e2e/idp.ts` change. `lapseSession` removes only the
  library's user. `ageToken` cannot edit an obtained time that now lives in
  page memory; a reload after sign-in gives the same "not fresh" state.
- Whether to re-record the bundle budget after the entry shrinks
  (`npm run bundle:check -- --record`). The check fails only on a rise.
- Which assertions in the nine unit test files move to the new helper, and
  which are deleted for the reason above.
- How fake-timer tests handle `getUser()`. Each read calls the library's
  `_events.load` (esm `:2955-2965`), which re-arms its access-token expiry
  timers. No lint rule limits a test's import of oidc-client-ts; the stall
  tests import it today.

## How we will know it worked

- These checks hold:
  - `rg -n "MIRROR_KEY|isMirror|readMirror|writeMirror|clearMirror|mirrorRenewed|rememberTenant\(.*mirror" web/src web/e2e`
    finds nothing.
  - `rg -n "\bheld\b" web/src/api/token.ts` finds nothing.
  - `rg -n "tyre\.auth\.mirror" web/src` finds only the old key's one
    removal and its test.
  - `rg -n -i "mirror" web/src web/e2e` finds no comment about the session.
- The nine stall tests and the new tests above pass, each new one shown
  failing first.
- `make check` is green, and the e2e `auth` project passes.
- The bundle check passes, with the library still in the entry's static
  closure.
