# Design: error recovery on the driver's pages (TYRE-334)

Ticket TYRE-334, as U179 left it (comments 14142, 14144, 14146): the core bug
was fixed on PR #167, and what stays is the notice for a failed refresh and
four folds, TYRE-333, TYRE-339, TYRE-340 and TYRE-335. U168 ruled it a large
ticket. The owner's two answers of 19 Nov 2026 are under "The owner's
answers".

**Requirements touched, none changed:**

- FR-OFF-001, FR-OFF-002, FR-OFF-003: the session's reference data, and its
  refresh on app-open and on demand.
- FR-OFF-005, FR-OFF-006, FR-OFF-013, FR-OFF-014: the buffer, and no silent
  discard.
- NFR-AVL-002, FR-AUT-005: starting needs the server, and who may capture a
  unit.
- NFR-USE-004, NFR-USE-005, NFR-USE-009, NFR-USE-011, and NFR-USE-007 (a
  Should).
- IR-UI-009: a destructive action is confirmed and names what it affects.

The SRS has no row for a refresh that fails with a copy in hand, a failed
write to the text buffer, or a page that throws while rendering. Nothing here
contradicts a row, so no SRS change is prepared.

## Intent

A driver's page can fail in four ways that the app handles badly today. Each
one leaves the driver either misinformed or stuck, and a stuck phone is a
driver who stops capturing (project brief, section 3; ADR-0009, "Why the
outbox is not negotiable").

1. **A refresh fails and nobody is told.** The start screen shows a vehicle
   from an earlier day's copy with no sign that today's refresh failed
   (`web/src/capture/CaptureFlow.tsx:243-250`, `:297-306`). On My inspections
   the same failure replaces the task list with an error
   (`web/src/driver/DriverHome.tsx:13-16`, `:29-33`).
2. **A draft that breaks the page locks the phone** (TYRE-333). "Try again"
   remounts the page, the draft loads from IndexedDB again
   (`web/src/capture/useDraftLifecycle.ts:50-87`) and the page throws again.
   One draft per phone means no other inspection can start (FR-OFF-014).
3. **The error screen says readings are kept when they may not be**
   (TYRE-339). After a failed write the fault lives in the page's own state
   (`useDraftLifecycle.ts:40`), so the boundary cannot see it
   (`web/src/shell/RouteErrorBoundary.tsx:56`) and the remount forgets it.
4. **Cached server data that breaks the page cannot be replaced** (TYRE-340).
   A render that throws never commits, so no query observer subscribes and no
   refetch starts. Every "Try again" renders the same cached data.

TYRE-335 adds one accessibility fix: after "Try again" the focused button is
gone and focus falls to the document body.

## Goals

- A failed refresh with a copy in hand keeps the screen and says so, on the
  capture start screen and on My inspections. It adds no tap to the clean
  path.
- A refresh the server refuses for the vehicle itself stops the start screen
  with the refusal (owner, 19 Nov 2026).
- A page that fails twice in a row escalates: the next "Try again" fetches
  fresh server data first, and on the capture route the driver can discard
  the inspection on the phone, behind the existing confirmation.
- Nothing in that escalation drops the phone's only copy of a vehicle before
  a fresh one has arrived, and nothing touches the outbox.
- A storage fault is known to the error screen and survives a remount and a
  navigation, until the inspection it concerns has ended.
- Focus lands in the recovered page after an in-place "Try again".

## Non-goals

- **One failure table for every capture screen.** That is TYRE-465. This
  design adds a second presentation to the existing ladder in
  `CaptureFlow.tsx` and no new ladder.
- **A refused trailer.** A rig member whose refresh is refused stays
  TYRE-466's. This design only words it truthfully (section 1).
- **A draft row that cannot be read at all.** A row whose read rejects shows
  as a storage fault today (`useDraftLifecycle.ts:78-82`), not through the
  boundary. No writer in the app produces such a row. It gets no discard here.
- **Server data that is still broken after a fresh fetch.** That is a server
  bug, and no client action recovers from it.
- **Focus when the error screen first appears.** The message is a
  `role="alert"` and is announced. TYRE-335 asks only for the retry.
- **Manager routes.** Their retry stays a page reload (TYRE-280).
- **Error reporting to an external service** (NFR-OBS-002). Not this ticket.

## Anti-goals

- No confirmation, modal or extra tap on the clean capture path
  (web/CLAUDE.md, The capture target).
- No `resetQueries` and no `removeQueries` on a capture context. Either one
  leaves a driver without signal with no vehicle (FR-OFF-001, FR-OFF-002).
- No discard without a person confirming it, and never of another driver's
  draft (FR-OFF-014, U104).
- No second class component and no `react-error-boundary` (U54, TYRE-280).
- No fault flag written to the store whose writes are failing.

## Constraints

- **Rule 7 and ADR-0009.** Reads are live and held in memory for the session.
  The draft is the one thing held durably.
- **U186.** Past Start, the walk-around and the review read contexts held in
  component state. A boundary remount loses that state, and the remounted
  page resumes through the draft's windowed read
  (`web/src/capture/useRigComposition.ts:83-97`).
- **U148 and U182.** A draft's windowed read never goes stale by itself.
  Section 4 replaces that copy in one case only, and says why that is safe.
- **U179.** A failed or paused refresh keeps the copy, and Start on an
  earlier day's copy is allowed.
- **The capture bundle budget.** The boundary and everything under
  `src/capture/` are in the entry. A rise in the entry is named in the PR
  with the import that caused it (U84, U200).
- **Copy.** Sentence case, straight quotes, no em dashes (`/unslop`). Dates
  go through `src/time/tenantTime.ts` (rule 6).
- **Targets.** A driver's control takes the glove size (NFR-USE-004).

## Approaches

### Where the storage fault lives (TYRE-339)

| Approach | Trade-off |
| --- | --- |
| **A. In memory, above the boundary.** A small store the capture page writes and both the page and the boundary read | Survives a remount and a navigation. Lost on a page reload, where it is no longer needed: a reload shows exactly what storage holds |
| B. A flag saved with the draft | The flag goes through the write path that is failing. A write over quota fails with `QuotaExceededError`, so the flag may never land |
| C. A flag in `localStorage` | A second store with its own limit and its own eviction, and a second place the driver's state lives |

**Chosen: A.** A failing store cannot be trusted to record its own failure.
The fault is a fact about this session's writes, so the session's memory is
where it belongs.

### How a page recovers from cached server data (TYRE-340)

| Approach | Trade-off |
| --- | --- |
| A. `resetQueries` on retry | Drops the data first. Offline the fetch pauses and the vehicle is gone. Ruled out by the ticket |
| **B. Fetch first, keep the copy on failure, then remount** | The library keeps the earlier data when a refetch fails or pauses. The driver waits for one bounded fetch |
| C. Remount at once and fetch in the background, retrying when data lands | No wait, but the boundary must watch the cache and retry itself, which is a second retry mechanism |

**Chosen: B.** It is the documented way to replace cached data without
losing it, and it leaves one retry path.

### When the escalation starts

| Approach | Trade-off |
| --- | --- |
| **A. On the second failure in a row** | A one-off glitch keeps today's instant retry, the draft's vehicle data is replaced only for a page that keeps failing, and a driver is not shown Discard for a glitch. One counter in the boundary |
| B. From the first failure | One rule, but every retry can wait up to ten seconds on bad signal, and Discard is on screen at the first error |

**Chosen: A**, by the owner (19 Nov 2026).

## The design

### 1. A failed refresh on the capture start screen

Only the start screen reads a refreshing copy. Past Start the screens read
held contexts (U186), and a draft's windowed read does not refresh (U182).

The start screen has three outcomes when a unit's query holds data and its
last fetch failed:

1. **The vehicle itself was refused (a 403).** The screen is the refusal a
   first load shows, with "Back to work" and no Start
   (`CaptureFlow.tsx:40-45`, `:76`). The copy stays in the cache, and a later
   refresh that succeeds brings the start screen back.
2. **Any other failure of the vehicle or of a rig member.** The start screen
   stays, Start stays enabled (U179), and a notice sits above it.
3. **A rig member was refused.** The start screen stays with the member's
   refusal as the notice. What Start should then do is TYRE-466's.

The notice:

- It is one decision with two presentations. The ladder that picks
  `LoadFailure`'s sentence and control (`CaptureFlow.tsx:66-93`) also picks
  the notice's, so the two cannot drift before TYRE-465 replaces the ladder.
- The sentence for lost signal is: "Could not refresh this vehicle. Showing
  the copy from 18 Nov. Find signal, then reload." For a rig member, "the
  rest of the rig" replaces "this vehicle". The date is the copy's, in the
  tenant's calendar.
- The other answers reuse `LoadFailure`'s sentence with "refresh" for "load"
  and the same "Showing the copy from ..." sentence after it.
- Its control is `LoadFailure`'s for the same answer: "Reload vehicle" or
  "Reload rig" for lost signal (FR-OFF-003, on demand). The reload asks again
  for every unit whose refresh failed.
- It is `role="status"`, not an alert, and it does not move focus.
- When the vehicle and a member both failed, one notice shows, worded for the
  vehicle, with the older copy's date.

The "Loading…" the start screen shows while an earlier day's copy is being
fetched (U179) is unchanged.

### 2. A failed refresh on My inspections

`DriverHome` reads a failure only when there is no data, as `CaptureFlow`
does since #167. With a list in hand and a failed refresh:

- the list and its links stay;
- a `role="status"` notice reads "Could not refresh your inspections. This
  list may be out of date." or "Could not refresh your trip. It may be out of
  date.";
- the first-load errors, "Could not load your inspections." and "Could not
  load your trip.", are unchanged and still alerts.

This is on this branch because section 4's refresh can leave these queries
failed with data in hand, which is the state that drops the list today.

### 3. The storage fault (TYRE-339)

- **The store.** A module under `src/capture/` holds two independent facts
  for the tab's life, the two kinds `useDraftLifecycle.ts:13-17` names. They
  are two flags, not one slot, because once the fault outlives a mount both
  can be true at once. The capture page reads and writes them there instead
  of in its own state. The boundary reads them.
  - **Blocked** (today's `"unavailable"`): the phone would not let the app
    read or start a draft.
  - **Degraded**: a write failed with an inspection in hand.
- **What sets each.** Exactly what sets it today. Blocked: a draft read that
  rejects, and a Start whose write fails. Degraded: a failed write of a
  reading, a mark, a header or a discard, and a failed submit.
- **What clears each.**
  - Blocked clears when a draft read succeeds, which is what "Recheck
    storage" already tests.
  - Degraded clears when the inspection it concerns is no longer on the
    phone: the queue write at submit resolved, a discard resolved, or a draft
    read succeeded and found no draft. The last covers a draft the browser
    evicted, and an error later in a submit that had already queued, so the
    warning can never outlive its inspection.
  - A draft read that finds a draft leaves degraded standing.
  - A page reload clears both, since the store is memory.
  - A remount, a "Try again" and a navigation inside the app clear neither.
- **The warning.** The two banners in `CaptureFlow.tsx:413-428` are unchanged
  in words and place. One shows at a time. Blocked takes it, with "Recheck
  storage", and blocks Start as today. Otherwise degraded shows its own. When
  a recheck clears blocked, degraded shows again if it still stands. A banner
  now shows on every mount while its fact stands, so it survives "Try again".
- **The error screen on the capture route:**
  - neither: "Readings already entered are kept on this phone.", as today;
  - degraded, whether or not blocked: "This phone was not saving reliably, so
    the last readings you entered may be missing. Check each position after
    you try again.";
  - blocked alone: no line about readings.

After the remount the page shows what storage holds, so a reading typed after
the fault shows as not done. The line above is what tells the driver why.

### 4. The second failure in a row (TYRE-340, TYRE-333)

**The count.** The boundary counts the failures it has caught at the current
location. A navigation resets the count with the error, as it resets the
error today (`RouteErrorBoundary.tsx:34-39`). A successful commit does not
reset it: a page with a poisoned draft commits "Loading…" before the draft
arrives and only then throws (`useDraftLifecycle.ts:50-87`), so a commit is
not a recovery.

**The first failure** is today's screen and today's retry, unchanged.

**From the second failure, on `/capture/:vehicleId` and `/my`:**

- The lead line reads "This page still cannot be shown."
- Under it: "Try again fetches a fresh copy first. Find signal if you can."
- "Try again" then does three things in order:
  1. It goes busy and reads "Trying again…". A second tap does nothing.
  2. It fetches the route's server data again: on the capture route every
     cached capture context, at-now and windowed; on `/my` the task list and
     the trip. It waits for those fetches, but no longer than
     `REQUEST_TIMEOUT_SECONDS` (`web/src/api/deadline.ts:5`). A fetch that
     fails or pauses leaves the copy it had.
  3. It remounts the page.
- A navigation during the wait wins: the late result remounts nothing.

**Why replacing a draft's windowed copy is safe here.** U148 and U182 keep a
loaded copy from changing under a draft. This fetch is the one a cold reload
of the same draft makes, for the same window, and U187 made the server count
that answer to the draft's start day. Comment 14153 on the ticket records how
far a cold reload matches a same-tab resume. It runs only for a page that has
failed twice, and no screen is reading the copy while the error shows.

**Discard, on the capture route only.** From the second failure the error
screen also offers the existing `ConfirmDiscard`
(`web/src/capture/ConfirmDiscard.tsx`), below "Try again" and secondary to
it.

- **When it shows.** The phone holds a draft, for any vehicle, that the
  signed-in driver may carry (`mayCarry`, `web/src/capture/outbox.ts:185`).
  A draft that cannot be read, or that is another driver's, gets no discard
  (U104).
- **Words.** Trigger "Discard this inspection". Question "Discard the
  inspection of H-101?", from the draft's own fleet number, or "this vehicle"
  when it has none (IR-UI-009). The consequence is the capture screen's own
  count sentence (`CaptureFlow.tsx:184-190`). "Keep it" stays first.
- **A draft that cannot be counted.** The draft is the suspect, so reading it
  must not break the error screen. If the count throws, the consequence reads
  "Everything entered for it will be lost."
- **What it deletes.** The draft row only (`clearDraft`,
  `web/src/capture/draft.ts:252-254`). The outbox table is not read or
  written.
- **After it.** On success the count and the error clear, a `"degraded"`
  fault clears, and the page remounts on the start screen. On failure the
  error screen stays, the fault becomes `"degraded"`, and a line reads "Could
  not discard it. This phone is not saving reliably."

Discard can be on screen when the cause is server data, not the draft. That
is accepted: the confirmation names what is lost, and "Try again" is the
first control.

### 5. Focus (TYRE-335)

After an in-place "Try again", plain or escalated, and after a discard from
the error screen, focus moves to the main landmark the boundary sits in, made
focusable with `tabindex="-1"`. If the recovered page has already taken focus
itself, such as a reopened position sheet, focus is left where the page put
it. A touch user must not see a focus ring drawn round the whole page.

### 6. Documentation

- `web/CLAUDE.md`, The network: the render-error bullet says what now happens
  after a storage fault, at the second failure, and on `/my` (TYRE-339's
  definition of done).
- `web/CLAUDE.md`, Conventions: unchanged. The boundary is still the one
  class.

## Tests

All vitest, driving the real components. A stub that throws on its own proves
nothing about the route, so each case seeds data that makes a real component
throw. If no real draft or context shape throws today, one child may be
mocked to throw when it sees a marker in the seeded data, and the test says
so.

| Case | Where |
| --- | --- |
| A failed refresh with a copy keeps the start screen, shows the notice with the copy's date, and Start works | `CaptureFlow.test.tsx` |
| The notice's reload fetches again, and a success removes it | same |
| A refused refresh of the vehicle shows the refusal and no Start, and a later success restores the start screen | same |
| A member's refused refresh keeps the start screen with the refusal as the notice | same |
| A first load with no data still shows the load error (exists, must stay green) | same |
| My inspections keeps its list and links on a failed refresh and shows the notice, for the tasks and for the trip | `DriverHome.test.tsx` |
| A failing write, then a render error: the error screen does not say readings are kept. "Try again": the banner is still there | `RouteErrorBoundary.test.tsx` or a capture test beside it |
| Degraded clears when the inspection is queued, when it is discarded and when a draft read finds no draft; it stands on a navigation and when a read finds the draft | the store's own test |
| Degraded stands, then a draft read rejects: the blocked banner and "Recheck storage" show, Start is blocked, and the error screen still says readings may be missing. A recheck that finds the draft brings the degraded banner back | a capture test |
| A throwing draft: the first error has no Discard, the second has it, the confirmed discard lands on the start screen, and a seeded outbox entry is still there | `RouteErrorBoundary.test.tsx` |
| No Discard for another driver's draft, or with no draft | same |
| A draft whose count throws still shows the confirmation, with the fallback sentence | same |
| A throwing capture context: the first "Try again" fails again, the second fetches and recovers | same |
| The same with the fetch failing: the copy is still in the cache afterwards, and the page reads it | same |
| The same on `/my` | same |
| A windowed entry seeded with `initialData` and never fetched is fetched by the escalated retry | same |
| Focus is on the main landmark after an in-place retry, and is left alone when the page took it | same |
| Navigating from a working page into a throwing one shows the error in the shell | same (TYRE-335) |
| Browser back from the error shows the page before it | same (TYRE-335) |
| The `onCaughtError` count for a rejected lazy import is pinned at what the test observes | same (TYRE-335) |

If the lazy import's count is not 1, the builder reports it and does not
adjust the test to pass.

## The owner's answers

Both of 19 Nov 2026, at the Product questions stop.

1. **A second failure in a row.** "Escalate on 2nd failure": the first "Try
   again" stays instant, and only after a second failure does it fetch fresh
   data first and offer Discard on a capture.
2. **A refused refresh of the vehicle on the start screen.** "Stop with the
   refusal": the first-load refusal screen, with no Start. A refused trailer
   stays TYRE-466's.

## Lead's calls

| Question | Call | Source |
| --- | --- | --- |
| Where the fault lives | In memory, above the boundary | A write over quota "fails with a `QuotaExceededError` exception": https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria |
| How to replace cached data without losing it | Fetch, keep the copy on failure, then remount. Never reset | `resetQueries` "Resets queries matching the given filters back to their initial state": https://tanstack.com/query/v5/docs/reference/QueryClient and `web/node_modules/@tanstack/query-core/build/modern/queryClient.js:272-285`. A failed fetch keeps `data`: `.../query.js:504-516`, and `isRefetchError` "has an error and still has data to display": https://tanstack.com/query/latest/docs/framework/react/reference/useQuery |
| The wait is bounded | By `REQUEST_TIMEOUT_SECONDS`, the app's one transport bound | `web/src/api/deadline.ts:1-5`. `/my`'s queries retry three times by default, so the fetch alone is not a bound |
| The boundary stays hand-written | One class, no package | "There is currently no way to write an Error Boundary as a function component": https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary and U54 |
| Where focus goes | The main landmark, with `tabindex="-1"` | When the active element is removed "browsers move focus to the body element", and authors must manage it "so focus remains visible and moves logically": https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/ |
| My inspections is fixed here | On this branch | It is on the path of section 4's refresh (`docs/how-work-runs.md`, Which bugs a branch fixes) |
| The notice has a reload control | Yes | FR-OFF-003 asks for a refresh on demand |
| One fault slot or two flags | Two flags, and degraded also clears when a read finds no draft (builder check, 19 Nov 2026) | `web/src/capture/useDraftLifecycle.ts:78-82` can reject while a failed write's fault stands, and `web/src/capture/CaptureFlow.tsx:224-229` catches errors raised after the queue write |
| The count resets on navigation only | Yes | `web/src/capture/useDraftLifecycle.ts:50-87`: the page commits before the draft loads |

## Left to the builder

- The store's shape and how a class reads it. `useOutbox.ts` reads an
  external store with `useSyncExternalStore` and is the nearest pattern.
- How the capture route's error content reaches the boundary. `Chrome.tsx`
  already imports from `src/capture/`, so a shell file importing a capture
  component has a precedent.
- How the escalated retry fetches. One trap is known: `refetchQueries` skips
  an unobserved query that has never fetched
  (`.../queryClient.js:360-371`, `.../query.js:186-198`), and the windowed
  entries `useRigComposition.ts:87-97` seeds are exactly that. The same call
  resolves at once for a paused query, which is the behaviour wanted offline.
- Which cached capture contexts to fetch, if narrower than all of them is
  simple.
- The notice's CSS, from the existing capture classes and tokens only.
- How focus avoids a ring round the page.
- Running `web-design-guidelines` over the changed UI files before the last
  `make check`.
