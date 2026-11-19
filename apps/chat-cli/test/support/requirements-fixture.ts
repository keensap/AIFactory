import { NFR_DOMAINS } from '../../src/stages/requirements-contract.ts'

export const COVERED_REQUIREMENTS = `# Requirements Specification — Test

## 1. Purpose and scope

Let customers see their orders.

| Boundary | Items |
|---|---|
| In scope | Order list |
| Out of scope | Placing orders |
| Deferred | none |

## 2. Actors and permissions
| Actor | Goal | Permissions |
|---|---|---|
| Customer | See orders | Read own orders |

## 3. Functional requirements
| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| FR-001 | Customer | Opens portal | Shows orders | Account | Order list | Empty state | must | AC-001 |

## 4. Non-functional requirements
| domain | id | target | verification |
|---|---|---|---|
| performance | NFR-001 | p95 below 300 ms | Load test |
${NFR_DOMAINS.filter(({ domain }) => domain !== 'performance').map(({ domain }) => `| ${domain} | not applicable — outside this test fixture | — | — |`).join('\n')}

## 5. Acceptance criteria
| id | requirement | Given | When | Then |
|---|---|---|---|---|
| AC-001 | FR-001 | Customer has orders | Portal opens | Orders appear |
| AC-002 | NFR-001 | Test dataset | Load test runs | p95 is below 300 ms |

## 6. Assumptions, constraints and open questions
| id | type | statement | owner | impact if wrong | resolve by | status |
|---|---|---|---|---|---|---|
| A-001 | assumption | Existing accounts are available | Product | Sign-in flow must be added | 2026-12-31 | open |

## 7. Traceability
| requirement | source | goal |
|---|---|---|
| FR-001 | Brief | Customers can see orders |
| NFR-001 | Brief | Portal responds promptly |
`

/**
 * A believable requirements specification, written the way the author prompt's
 * template asks for it: six functional requirements with every field and a
 * MoSCoW priority, two business rules (a decision table and a state
 * transition), a small glossary, real NFRs for the domains a clinic booking
 * service needs, reasoned not-applicable rows for the rest, an acceptance
 * criterion for every FR, NFR and business rule, scope stated three ways, a
 * typed register with owners, impacts and resolution dates, and traceability
 * to sources and goals. It must produce zero findings from every deterministic
 * checker.
 */
export const REALISTIC_REQUIREMENTS = `# Requirements Specification — Riverside Clinic Booking

## 1. Purpose and scope

Riverside Clinic takes appointment requests by phone, which leaves the front desk overloaded and double-books clinicians about twice a week. The outcome is an online booking service where patients book, cancel and receive reminders themselves, while reception keeps control of the clinicians' calendars.

| Boundary | Items |
|---|---|
| In scope | Online slot search and booking for registered patients; cancellation; reception rescheduling; SMS and e-mail reminders; clinician schedule management |
| Out of scope | Billing and insurance claims; telemedicine video calls; clinical records |
| Deferred | Waiting-list auto-fill when a slot is released; native mobile apps |

### Glossary

| term | definition | source |
|---|---|---|
| Slot | A bookable interval in one clinician's published weekly schedule | Clinic administrator interview notes (input document) |
| Booking | A slot reserved for one patient, identified by a reference number | Brief |
| Service hours | 06:00 to 22:00 local time, the window the availability target covers | none |

## 2. Actors and permissions

| Actor | Goal | Permissions |
|---|---|---|
| Patient | Book and manage their own appointments | Search open slots; create, view and cancel own bookings |
| Receptionist | Keep the daily calendar accurate | View all bookings; reschedule or cancel any booking; record a reason |
| Clinic administrator | Publish clinician availability | Create, edit and close clinician schedules; view audit log |
| Reminder service | Notify patients before appointments | Read upcoming bookings and patient contact preferences only |

## 3. Functional requirements

| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| \`FR-001\` | Patient | Opens the booking page and picks a service | Lists open slots for the chosen service over the next 28 days | Service type, preferred clinician (optional), date range | Slot list grouped by day with clinician name | No open slots shows the next available date and the clinic phone number | must | \`AC-001\` |
| \`FR-002\` | Patient | Confirms a selected slot | Books the slot for the signed-in patient and holds it atomically | Slot id, patient id, reason for visit | Booking confirmation with reference number, sent by e-mail | Slot taken by another patient in the meantime returns a conflict and refreshed slots | must | \`AC-002\`, \`AC-003\` |
| \`FR-003\` | Patient | Chooses cancel on an upcoming booking | Cancels the booking and releases the slot | Booking reference | Cancellation confirmation; slot reappears in search | Cancellation within 2 hours of the start is refused with the clinic phone number | must | \`AC-004\` |
| \`FR-004\` | Receptionist | Drags a booking to another slot or picks a new slot | Moves the booking and notifies the patient of the new time | Booking reference, new slot id, reason | Updated booking; patient notification | Target slot already booked is refused and the original booking is kept | must | \`AC-005\` |
| \`FR-005\` | Reminder service | Scheduled job runs every 15 minutes | Sends a reminder 24 hours before each confirmed appointment using the patient's preferred channel | Upcoming bookings, contact preferences | SMS or e-mail reminder; delivery status stored | Delivery failure is retried once and then flagged for reception | should | \`AC-006\` |
| \`FR-006\` | Clinic administrator | Saves a clinician's weekly schedule | Publishes bookable slots from the schedule and blocks slots on leave days | Clinician id, weekly hours, slot length, leave dates | Bookable slots visible in search | Overlap with existing bookings is reported and those bookings are not removed | must | \`AC-007\` |

### Business rules

| id | type | rule | applies to | acceptance criteria |
|---|---|---|---|---|
| \`BR-001\` | decision table | Patient cancels online, start at least 2 hours away: allowed; patient, start under 2 hours away: refused with the clinic phone number; receptionist, any time before the start: allowed with a reason | \`FR-003\` | \`AC-015\` |
| \`BR-002\` | state transition | A booking moves held → confirmed on confirmation, confirmed → rescheduled when reception moves it, and confirmed or rescheduled → cancelled; a cancelled booking never returns to confirmed | \`FR-002\`, \`FR-003\`, \`FR-004\` | \`AC-016\` |

## 4. Non-functional requirements

| domain | id | target | verification |
|---|---|---|---|
| performance | \`NFR-001\` | Slot search returns within 800 ms at p95 with 200 concurrent patients | Load test against a production-sized dataset before release |
| availability | \`NFR-002\` | 99.5% monthly availability between 06:00 and 22:00; recovery within 4 hours | Uptime monitor report and a quarterly restore drill |
| security | \`NFR-003\` | Patients and staff sign in with password plus one-time code; sessions expire after 30 minutes idle | Penetration test and automated session-expiry test |
| privacy | \`NFR-004\` | Only name, contact details and visit reason are stored; data is deleted 24 months after the last visit | Data inventory review and a deletion job test |
| accessibility | \`NFR-005\` | Patient pages meet WCAG 2.2 AA | Automated axe scan plus a manual screen-reader audit |
| observability | \`NFR-006\` | Booking conflicts and reminder failures are logged and alert reception within 5 minutes | Alert rule test in staging and a monthly log review |
| compliance | \`NFR-007\` | Processing follows GDPR; every booking change is kept in an audit log for 6 years | Audit log retention test and DPO sign-off |
| scalability | not applicable — a single clinic with 12 clinicians; NFR-001 already sizes peak load | — | — |
| localisation | not applicable — the clinic serves English-speaking patients only and the brief excludes translation | — | — |
| maintainability | not applicable — the service is configured on the vendor platform and no custom code is maintained by the clinic | — | — |
| portability | not applicable — hosted SaaS accessed through supported browsers only | — | — |

## 5. Acceptance criteria

| id | requirement | Given | When | Then |
|---|---|---|---|---|
| \`AC-001\` | \`FR-001\` | Dr Patel has three open slots tomorrow | A patient searches for a general consultation | The three slots appear under tomorrow with Dr Patel's name |
| \`AC-002\` | \`FR-002\` | A signed-in patient has selected an open slot | The patient confirms the booking | A booking reference is shown and the confirmation e-mail arrives within 2 minutes |
| \`AC-003\` | \`FR-002\` | Two patients have selected the same slot | Both confirm within one second | Exactly one booking succeeds and the other patient sees a conflict message with refreshed slots |
| \`AC-004\` | \`FR-003\` | A patient has a booking starting in 3 hours | The patient cancels it | The booking is cancelled and the slot reappears in search within 1 minute |
| \`AC-005\` | \`FR-004\` | A receptionist views a booking whose target slot is free | The receptionist moves it and enters a reason | The booking shows the new time and the patient receives a notification |
| \`AC-006\` | \`FR-005\` | A confirmed appointment starts in 24 hours and the patient prefers SMS | The reminder job runs | One SMS is sent and its delivery status is stored |
| \`AC-007\` | \`FR-006\` | An administrator enters leave for Dr Patel next Monday | The schedule is saved | No Monday slots for Dr Patel appear in search and existing bookings are listed for follow-up |
| \`AC-008\` | \`NFR-001\` | A dataset of 12 clinicians and 6 months of bookings | 200 simulated patients search concurrently | p95 search latency is at most 800 ms |
| \`AC-009\` | \`NFR-002\` | The production uptime monitor is running | A calendar month ends | Measured availability in service hours is at least 99.5% |
| \`AC-010\` | \`NFR-003\` | A staff account is signed in | It stays idle for 31 minutes | The next request requires signing in again |
| \`AC-011\` | \`NFR-004\` | A patient's last visit was 24 months ago | The nightly deletion job runs | The patient's personal data is removed and the deletion is logged |
| \`AC-012\` | \`NFR-005\` | The release candidate is deployed to staging | The accessibility audit runs | No WCAG 2.2 AA violations remain on patient pages |
| \`AC-013\` | \`NFR-006\` | A reminder fails to deliver twice | The failure is logged | Reception receives an alert within 5 minutes |
| \`AC-014\` | \`NFR-007\` | A receptionist reschedules a booking | An auditor queries the audit log | The change, actor, time and reason are listed |
| \`AC-015\` | \`BR-001\` | A patient's booking starts in 90 minutes | The patient tries to cancel it online | Cancellation is refused and the clinic phone number is shown |
| \`AC-016\` | \`BR-002\` | A booking was cancelled | A receptionist tries to confirm it again | The change is refused and the booking stays cancelled |

## 6. Assumptions, constraints and open questions

| id | type | statement | owner | impact if wrong | resolve by | status |
|---|---|---|---|---|---|---|
| \`A-001\` | assumption | Patients already have clinic accounts with verified e-mail addresses | Practice manager | A self-registration and verification flow must be added before launch | 2026-07-15 | open |
| \`A-002\` | dependency | The SMS gateway contract covers 3,000 messages per month | Operations lead | Reminders fall back to e-mail only or the contract is renegotiated | none | confirmed |
| \`C-001\` | constraint | Go-live must happen before the winter flu season on 1 October | Clinic director | Phone booking stays the only channel for the busiest quarter | 2026-06-30 | open |
| \`Q-001\` | question | Should patients be able to book on behalf of a family member? | Practice manager | FR-002 needs a dependant model and extra permissions | 2026-06-15 | open |

## 7. Traceability

| requirement | source | goal |
|---|---|---|
| \`FR-001\` | SRC-001 (brief): "patients should see free times online" | Reduce phone calls to the front desk |
| \`FR-002\` | Brief; planning baseline TELOS report v1 (risk R-2 double booking) | Eliminate double bookings |
| \`FR-003\` | Brief: "let patients cancel without calling" | Reduce no-shows and phone calls |
| \`FR-004\` | Reception interview notes (input document) | Keep reception in control of the calendar |
| \`FR-005\` | Planning baseline TELOS report v1 (no-show rate 14%) | Reduce no-shows below 8% |
| \`FR-006\` | Clinic administrator interview notes (input document) | Accurate clinician availability |
| \`NFR-001\` | Planning baseline TELOS report v1 (peak Monday load) | Patients book without waiting |
| \`NFR-002\` | Brief: "online booking must be dependable" | Patients trust the online channel |
| \`NFR-003\` | Clinic IT policy (input document) | Protect patient accounts |
| \`NFR-004\` | GDPR data minimisation; clinic privacy notice | Lawful handling of patient data |
| \`NFR-005\` | Brief: elderly patient population | Every patient can book online |
| \`NFR-006\` | Reception interview notes (input document) | Problems are noticed before patients call |
| \`NFR-007\` | GDPR; regional health-records retention rule | Pass the annual data-protection audit |
`

/** Replace exactly one occurrence, so a failure mode cannot silently stop mutating the fixture. */
function mutate(text: string, from: string | RegExp, to: string): string {
  const count = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, `${from.flags.replace('g', '')}g`)) ?? []).length
  if (count !== 1) throw new Error(`requirements fixture mutation expected one match of ${String(from)}, found ${count}`)
  return text.replace(from, to)
}

const ROW = (id: string): RegExp => new RegExp(`^\\| \`${id}\` \\|.*\\n`, 'm')

/**
 * Named ways a requirements draft can be incomplete, each derived from the
 * realistic fixture by one targeted change (except the old trivial draft). Each
 * must produce at least one blocking finding in the runtime's combined report.
 */
export const FAILURE_MODES: Readonly<Record<string, string>> = {
  'missing section': mutate(REALISTIC_REQUIREMENTS, /## 7\. Traceability[\s\S]*$/, ''),
  'FR without acceptance criterion': mutate(
    mutate(REALISTIC_REQUIREMENTS, ROW('AC-007'), ''),
    'those bookings are not removed | must | `AC-007` |',
    'those bookings are not removed | must | none |',
  ),
  'dangling AC reference': mutate(REALISTIC_REQUIREMENTS, 'phone number | must | `AC-001` |', 'phone number | must | `AC-001`, `AC-099` |'),
  'duplicate FR id': mutate(REALISTIC_REQUIREMENTS, '| `FR-006` | Clinic administrator |', '| `FR-005` | Clinic administrator |'),
  'NFR without verification': mutate(REALISTIC_REQUIREMENTS, '| Load test against a production-sized dataset before release |', '| — |'),
  'missing NFR domain': mutate(REALISTIC_REQUIREMENTS, /^\| localisation \|.*\n/m, ''),
  'missing scope boundary': mutate(REALISTIC_REQUIREMENTS, /^\| Deferred \|.*\n/m, ''),
  'register entry without owner': mutate(REALISTIC_REQUIREMENTS, '| Operations lead |', '| — |'),
  'register entry without impact': mutate(REALISTIC_REQUIREMENTS, '| Phone booking stays the only channel for the busiest quarter |', '|  |'),
  'empty FR field': mutate(REALISTIC_REQUIREMENTS, '| Cancellation within 2 hours of the start is refused with the clinic phone number |', '|  |'),
  'trivial single-bullet draft': '# Requirements\n\n- FR-001 The system shall X.\n',
  'invalid priority': mutate(REALISTIC_REQUIREMENTS, '| should | `AC-006` |', '| high | `AC-006` |'),
  'open register entry without resolve-by': mutate(REALISTIC_REQUIREMENTS, '| 2026-06-30 | open |', '| none | open |'),
  'invalid register type': mutate(REALISTIC_REQUIREMENTS, '| `C-001` | constraint |', '| `C-001` | deadline |'),
  'business rule without acceptance criterion': mutate(
    mutate(REALISTIC_REQUIREMENTS, ROW('AC-016'), ''),
    '`FR-004` | `AC-016` |',
    '`FR-004` | none |',
  ),
  'business rule applying to an unknown FR': mutate(REALISTIC_REQUIREMENTS, '| `FR-003` | `AC-015` |', '| `FR-009` | `AC-015` |'),
  'inconsistent glossary term': mutate(REALISTIC_REQUIREMENTS, '| Service hours |', '| Slot |'),
}
