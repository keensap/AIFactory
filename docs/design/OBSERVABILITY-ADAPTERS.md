# Observability Adapters — Authoring Guide

How to add a monitor (Phoenix, OTLP collector, Datadog, …) without touching the AI Factory core.

Ports live in [`apps/chat-cli/src/observability/ports.ts`](../../apps/chat-cli/src/observability/ports.ts). The core depends **only** on that file.

---

## 1. What the core needs

Two capabilities, plus lifecycle:

| Port | Used by | Purpose |
|---|---|---|
| `TraceRecorder` / `TraceSpan` | stage runtime, logging | record run/role lifecycle, harness events, reviews, documents, human decisions; release per-project resources; expose the active trace ids |
| `ObservabilityReader` | HTTP API | project summary, project cleanup, health |
| `ObservabilityProvider` | composition root | bundle both and shut down within a deadline |

## 2. Invariants (enforced by contract tests)

Every adapter must guarantee:

1. **Never throws.** No method may throw into a stage run, an HTTP request, shutdown or project deletion.
2. **Never blocks.** Recording is synchronous and cheap; reads are bounded by the caller's deadline.
3. **Bounded memory.** Cap spans/providers; evict idle projects.
4. **Degrades visibly.** Unavailability is reported through `summary.available === false` and `health()`, not by failing the app.
5. **Provider-neutral DTOs.** Return `ObservabilitySummary`/`ObservabilityHealth`; do not add vendor fields to the ports.
6. **No vendor types outside the adapter.** `src/stage-runtime.ts`, `src/server.ts` and `src/logging/` must stay vendor-free.

`npm run check:observability:strict` enforces invariant 6 in CI.

## 3. Steps

### 3.1 Implement the ports

```ts
// src/observability/mymonitor/index.ts
import type {
  ObservabilityProvider, ObservabilityReader, ObservabilitySummary,
  RoleTraceInput, RunTraceInput, TraceRecorder, TraceSpan,
} from '../ports.ts'

class MySpan implements TraceSpan {
  readonly traceId: string
  readonly spanId: string
  setAttribute(key: string, value: string | number | boolean): void { /* never throw */ }
  addEvent(name: string, attributes?: Record<string, unknown>): void {}
  recordException(error: unknown): void {}
  setStatus(status: 'ok' | 'error', message?: string): void {}
  end(): void {}
}

class MyRecorder implements TraceRecorder {
  startRun(input: RunTraceInput): TraceSpan | undefined { /* … */ return undefined }
  startRole(input: RoleTraceInput): TraceSpan | undefined { return undefined }
  recordHarnessEvent(span: TraceSpan | undefined, event: HarnessEvent): void {}
  completeRole(span: TraceSpan | undefined, output: string): void {}
  failRole(span: TraceSpan | undefined, error: unknown): void {}
  recordReview(span: TraceSpan | undefined, decision: string, findings: number): void {}
  recordDocument(span: TraceSpan | undefined, kind: string, path: string): void {}
  recordHumanDecision(projectId: string, runId: string, decision: string): void {}
  async forgetProject(projectId: string): Promise<void> {}
  currentTraceContext(): { traceId: string; spanId: string } | undefined { return undefined }
}

class MyReader implements ObservabilityReader {
  async summary(projectId: string, hours: number): Promise<ObservabilitySummary> { /* … */ }
  async deleteProject(projectId: string): Promise<void> {}
  health(): ObservabilityHealth { /* … */ }
}

export class MyProvider implements ObservabilityProvider {
  readonly name = 'mymonitor'
  readonly recorder = new MyRecorder()
  readonly reader = new MyReader()
  async shutdown(): Promise<void> {}
}
```

Start from [`memory.ts`](../../apps/chat-cli/src/observability/memory.ts) — it is a complete, bounded implementation in ~250 lines.

### 3.2 Register it

```ts
// src/observability/registry/index.ts
registerObservabilityProvider('mymonitor', ({ env }) => {
  const endpoint = env.MYMONITOR_ENDPOINT
  return endpoint === undefined ? undefined : new MyProvider({ endpoint })
})
```

The factory receives the environment, so adapter configuration stays inside the adapter (`phoenix/config.ts` is the reference).

### 3.3 Select it

```sh
AIFACTORY_OBSERVABILITY_PROVIDER=mymonitor
```

Precedence: explicit provider → Phoenix when `AIFACTORY_PHOENIX_ENABLED` is on → no-op. Unknown names and throwing factories fall back to no-op; observability never blocks startup.

### 3.4 Test it

Add the factory to `test/observability-contract.test.ts`:

```ts
const providers = [
  ['noop', () => noopProvider],
  ['memory', () => createMemoryProvider()],
  ['mymonitor', () => new MyProvider()], // ← add
]
```

Then run:

```sh
npm test
npm run check:observability:strict
```

## 4. Free hardening

Wrapping is automatic and provider-agnostic, so adapters should not reimplement it:

- `CachedObservabilityReader` — TTL cache, single-flight, overall deadline, stale fallback, per-project invalidation.
- Provider cap/idle eviction is an adapter concern (`PhoenixTelemetry` shows one approach); the cache is not.

## 5. Checklist

- [ ] `ObservabilityProvider` exported with a stable `name`
- [ ] all recorder methods non-throwing, accept `undefined` spans
- [ ] reader returns a complete neutral summary, never throws
- [ ] `health()` reports provider, state, counters
- [ ] per-project resources released by `forgetProject` / `deleteProject`
- [ ] memory bounded (spans, projects, queues)
- [ ] `shutdown(timeoutMs)` resolves within the deadline
- [ ] registered in the registry; config read from env inside the adapter
- [ ] added to the contract test list; `check:observability:strict` passes
- [ ] no vendor import outside `src/observability/<adapter>/`
