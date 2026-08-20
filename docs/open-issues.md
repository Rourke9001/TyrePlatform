# Open issues

Mirrors the Jira epic **TYRE-11**, which is the live version. This page exists
so that a session working in the repo can see what is unresolved without
leaving the codebase.

An item here is **not work**. It is a blocker, with an owner and a phase it
blocks. When it closes, the answer goes into the specification in Confluence —
not into a ticket comment where nobody will find it again.

## Blocking code today

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| **OI-28** | Which of the three tread boxes is outer, centre and inner? | Any inspector | Capture screen layout; interpretation of every historical sheet | TYRE-12 |
| **OI-29** | Is the tyre-seller marketplace in or out? | Rourke + Sponsor | Tenancy model, before the P1 schema is frozen | TYRE-13 |
| **Q7 / Q8** | Do drivers have smartphones — which OS? What connectivity at depots and on route? | Sponsor | Everything about P3. iOS has no Background Sync. | TYRE-14 |

OI-28 is the cheapest and most damaging of these. The capture screen's keypad
auto-advances in a fixed order; if that order is wrong, every reading is
mislabelled, irregular-wear detection inverts, and no paper sheet can be
back-loaded. It is a five-minute conversation.

## Blocking the acceptance gate

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| OI-03 | Where does casing value come from? 49.2% of estate value sits in casings. | Sponsor | P4 / M3 | TYRE-16 |
| OI-04 | What is the 4mm removal threshold based on? | Sponsor | P4 / M3 | TYRE-16 |
| Q4 | Why are two casings valued at R0.00 — scrap, or a blank field? | Sponsor | P4 / M3 | TYRE-16 |

## Blocking the value proposition

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| OI-26 | Will drivers reliably enter the odometer? | Sponsor | Wear rate, cost-per-km, removal forecast | TYRE-17 |
| Q5 | Does odometer data exist anywhere today? | Sponsor | Back-loading | TYRE-17 |

Consequence to state plainly to the sponsor before any demo: **no historical
paper sheet can produce a wear rate.** Those metrics begin at first digital
capture. Do not promise cost-per-km on back-loaded paper.

## Configuration and register

| ID | Question | Owner | Blocks | Jira |
|---|---|---|---|---|
| OI-01 | What do the legacy serial-number prefixes mean? | Sponsor | Tyre register | TYRE-18 |
| OI-21 | How does a tyre physically get its branded number? | Sponsor | Onboarding audit | TYRE-18 |
| Q13 | Pressure in kPa or PSI, and where do targets come from? | Sponsor | P2 config | TYRE-18 |

Q13 is the one most likely to embarrass us: the wrong unit makes every
inflation-compliance figure *silently* wrong rather than visibly broken.

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
