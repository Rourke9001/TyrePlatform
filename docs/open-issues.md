# Open issues

Mirrors the Jira epic **TYRE-11**, which is the live version. This page exists
so that a session working in the repo can see what is unresolved without
leaving the codebase.

An item here is **not work**. It is a blocker, with an owner and a phase it
blocks. When it closes, the answer goes into the specification in Confluence —
not into a ticket comment where nobody will find it again.

The sponsor's answers of 22 Aug 2026 (Fleet Questions — Answers of Record
v1.0, Confluence) closed most of the register: OI-01, OI-03..08, OI-10/11,
OI-13/14/15, OI-21..28 and OI-30 are answered there and implemented by the
TYRE-42 recut. What follows is what remains open.

## Blocking a decision, not code

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| **OI-29** | Is the tyre-seller marketplace in or out? ADR-0003 is *Proposed*; deciders are engineer + sponsor jointly and no acceptance is recorded. | Rourke + Sponsor | Tenancy model, before the P1 schema is frozen | TYRE-13 |

## Shaping the analytics proposition

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| **OI-31** | Do BAC's trailers have hubodometers? | Sponsor | Whether cost-per-km covers the majority or the minority of tyres — trailer distance is MEASURED only from one (CHG-042) | TYRE-43 |
| **OI-32** | Driver-to-unit assignment: fixed per horse or pooled per trip? Who owns an uncoupled trailer? | Sponsor | Notification/task routing (not schema — `vehicle_driver` supports both) | TYRE-44 |
| **OI-33** | Obtain BAC's current inspection spreadsheets | Sponsor | History backfill; a check on the capture model; whether `reading_staleness_days` splits from `unit_staleness_days` (E1 item 3, TYRE-59) | TYRE-45 |
| **CHG-106** | Does anyone actually *measure* pressure during today's walk-around, or is tread the only thing gauged? | Sponsor | How much weight the inflation-compliance figures deserve | TYRE-46 |

## Domain / legal sign-off

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| **CHG-107** | Does SA regulation restrict retreads on steer axles? Seeded as `retreads_permitted = false` for STEER — fleet practice, not a legal claim; no authoritative source found. Pair with OI-17's domain-review list. | Sponsor / domain | Nothing; labelling only until answered | TYRE-47 |
| **OI-17** | Domain/legal review list — carries (per E1 item 12) the POPIA question: what happens to a deactivated driver's personal information? Default in force: NFR-PRV-004 — retained 84 months, then pseudonymised. | Sponsor / domain | Nothing; the default governs until answered | TYRE-64 |
| **OI-16** | The 2021 report pack (the printed source of the Appendix E worked examples) — would have to be dug for. Low priority: the worked examples are already pinned to the cent. | Sponsor | Nothing | — |

## Not technical, still first

| ID | Question | Owner | Jira |
|---|---|---|---|
| Q15 | IP ownership, equity and revenue split | Both parties | TYRE-15 |
| — | Platform name and domain | Rourke | TYRE-19 |
| — | POC agreement signed by both parties | Both | TYRE-15 |

Resolved 2026-08-20: Azure region + POPIA position (TYRE-20) — South Africa
North, verified and recorded in ADR-0002; environments and hosting in ADR-0005.
Note the platform name/domain (TYRE-19) becomes a hard blocker at custom-domain
setup.

Q15 blocks nothing technically. It is listed first because the working
agreement says, in its own words, that leaving it ambiguous between family
members is the most common way arrangements like this end badly.
