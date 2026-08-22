# ADR-0009: Client platform and on-device data

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Rourke (engineer) · Sponsor (domain authority) — answered directly, 22 August 2026
- **Closes:** OI-07 · OI-08 · **Supersedes:** the offline-first assumption in SRS §4 OFF
- **Related:** ADR-0001 (stack — React + Vite PWA) · CR-007 · NFR-PRV-002/006 · TYRE-4 (P3 epic)

## Context

SRS v1.3 and epic TYRE-4 assume an **offline-first** capture app: a local database, a sync engine, and conflict resolution. That assumption was made before anything was known about the devices or the signal.

Two answers change it.

**On devices (OI-07):**

> _"At BAC all drivers have smartphones, Android, and should always have internet connection when they carry an inspection. Phones are personal so I can't give specifics. Someone with an iPhone should also be able to use the app."_

**On what the app should hold (OI-08):**

> _"The phone should just retrieve log data from the API and not actually store db records personally. We can have some caching option?"_

And, separately, push notifications were de-scoped:

> _"I wouldn't focus too much on the push notification now, as the fleet controller can just call the driver to tell them to carry an overdue inspection."_

### What was verified about iOS

| Capability | Android | iOS |
| --- | --- | --- |
| Web push | Full | iOS 16.4+, **and only after the user manually adds the app to the home screen** — no install prompt exists |
| Background sync | Supported | **Not available** — Background Sync, Periodic Sync and Background Fetch are all absent |
| Offline storage | Generous | **~50MB cap**, and cached data is **evicted after 7 days** without the app being opened |

An offline-first design would have depended on background sync and multi-day local storage — the two things iOS does not provide. Push being de-scoped removes the remaining reason to care about the first row.

## Decision

**A PWA. Online-first for reads. A durable outbox for the one inspection being captured. No offline database and no sync engine.**

1. **Platform: installable PWA**, per ADR-0001's React + Vite choice. One codebase for both platforms; no app-store gatekeeping, which matters because the devices are personally owned and cannot be managed; instant updates; fits CR-007. It does not foreclose native — the same codebase can be wrapped later.
2. **Reference data is not stored at rest.** Vehicles, tyre records and history are fetched from the API and cached in memory for the session only. No local database, no conflict resolution, no stale data, and almost no personal information on a personal phone. This is the sponsor's instruction and it is correct.
3. **The in-progress inspection is buffered locally** — as a durable outbox for _one form_, not a database.
4. **Web push is out of P1.** The Q9 schedule and task model is retained; the driver sees due inspections on opening the app, and the controller phones them, as happens today.

### Why the outbox is not negotiable

A driver completing a superlink enters roughly 78 readings across 26 wheels. If the submit fails — a dropout in a yard between buildings, under a workshop canopy, at a rest stop — and that work is lost, the driver will not do it again, and their cooperation is lost permanently. That is the adoption risk the whole product depends on, arriving through the back door.

The buffer holds one form for minutes or hours, never days. Consequently the iOS 7-day eviction and 50MB limits stop being design constraints, and the BYOD exposure reduces to "a partly-completed form".

**Flow:** open app → fetch from API (requires signal) → capture, writing each entry to the buffer as it is entered → submit, immediate if online, otherwise queued with a visible _"1 inspection waiting to send"_ → buffer cleared on success. Sync happens on app-open and on an explicit **Sync now** control — never via background sync, which does not exist on iOS and cannot be relied upon on Android either.

## Options considered

### Option A — Offline-first with a local database and sync engine _(the SRS v1.3 assumption)_

| Dimension | Assessment |
| --- | --- |
| Complexity | **High** — the sync engine and conflict resolution are the single largest cost in the P3 epic |
| iOS viability | **Poor** — depends on background sync (absent) and multi-day storage (evicted at 7 days) |
| Privacy | Worst — a full tenant dataset at rest on a personally-owned phone |

**Rejected.** It is the most expensive option, the least viable on one of the two target platforms, and the sponsor explicitly does not want tenant records on driver phones.

### Option B — Pure online, no local buffer

Simplest possible. Fails only when signal fails.

**Rejected**, despite being close to a literal reading of the sponsor's answer. The failure mode is losing a completed walk-around, which is unrecoverable in the way that matters: it destroys driver trust, and drivers are the data source.

### Option C — Online-first reads, durable submit outbox _(chosen)_

**Pros:** delivers the sponsor's intent (no records at rest) while removing the catastrophic failure; skips the expensive parts of offline-first entirely; makes route coverage largely irrelevant, which matters because OI-08 could not be answered precisely.
**Cons:** the app is unusable with no signal at the _start_ of an inspection, since reference data must be fetched. Accepted: the sponsor states signal is available at inspection time, and the alternative costs a sync engine.

### Option D — Native app

**Rejected.** Two codebases against a single-engineer constraint, app-store distribution onto personally owned phones with no MDM, and no offsetting benefit now that push is out of scope.

## Trade-off analysis

The decision turns on separating two things the sponsor's answer bundled: **storing a dataset** and **buffering a form**. The first is a liability — privacy exposure, sync cost, staleness — and the sponsor is right to refuse it. The second is insurance on the single most valuable and least repeatable act in the system, and it costs one local key-value write per keystroke.

Option A pays a large cost for a capability that iOS partly cannot deliver. Option B saves a trivial cost and risks the thing the product cannot afford to lose. Option C is the only one whose costs sit where the risks are.

A secondary benefit worth recording: **this decision de-risks an unanswered question.** OI-08 (route coverage) could not be answered precisely, and under Option C it no longer needs to be — the app must only survive long enough to retry.

## Consequences

**Easier**

* The P3 epic loses its largest and riskiest component
* iOS support becomes a documented lower tier rather than a blocker
* The privacy notice makes a much narrower and more defensible claim about on-device data
* OI-08 stops being a blocker

**Harder**

* The app requires signal to _begin_ an inspection. If OI-08 later proves worse than stated, this is the decision to revisit first
* iOS users must be walked through "Add to Home Screen" manually
* A stale-queue warning is needed at roughly two days, because on iOS an unsynced buffer is genuinely at risk of eviction
* Data cost falls on drivers' personal airtime — payloads must stay small, photos compressed, photo upload deferrable to WiFi. A reimbursed data allowance is the cheapest way to remove this objection

**To revisit**

* Push notifications, if the phone-call fallback proves insufficient at scale
* Native wrapping, if iOS becomes a primary platform
* The online-first read path, if OI-08 is answered and is worse than assumed

## Action items

1. Remove offline sync engine FRs from SRS §4 OFF; replace with online-first + outbox
2. Remove web push FRs from P1; retain schedule and task FRs
3. Re-scope **TYRE-4** — the sync engine is no longer in it
4. Add the guided iOS install step, Sync now control and stale-queue warning to the capture prototype
5. Add a data-frugality NFR (payload size, photo compression, WiFi-deferred upload)
6. Amend the NFR-PRV-006 notice to describe what is held on-device: one in-progress form, nothing else
7. Put the reimbursed-data-allowance suggestion to the sponsor
8. Close OI-07; close OI-08 as _"signal generally available at inspection time — unverified, and no longer load-bearing"_
