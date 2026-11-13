/**
 * No-op observability provider.
 *
 * Default when observability is disabled and in tests. It makes the ports
 * exercisable without a backend, an SDK or network access.
 */

import type {
  ObservabilityHealth,
  ObservabilityProvider,
  ObservabilityReader,
  ObservabilitySummary,
  TraceContext,
  TraceRecorder,
  TraceSpan,
} from './ports.ts'

class NoopTraceRecorder implements TraceRecorder {
  startRun(): TraceSpan | undefined { return undefined }
  startRole(): TraceSpan | undefined { return undefined }
  recordHarnessEvent(): void {}
  completeRole(): void {}
  failRole(): void {}
  recordReview(): void {}
  recordDocument(): void {}
  recordHumanDecision(): void {}
  async forgetProject(): Promise<void> {}
  currentTraceContext(): TraceContext | undefined { return undefined }
}

export class NoopObservabilityReader implements ObservabilityReader {
  async summary(projectId: string, hours: number): Promise<ObservabilitySummary> {
    return {
      available: false,
      reason: 'observability is disabled',
      projectName: projectId,
      windowHours: Math.max(0, hours),
      traces: 0,
      spans: 0,
      errors: 0,
      tools: 0,
      tokens: 0,
      latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
      roles: [],
      lastSpanAt: null,
      truncated: false,
    }
  }

  async deleteProject(): Promise<void> {}

  health(): ObservabilityHealth {
    return {
      provider: 'noop',
      enabled: false,
      state: 'disabled',
      projects: 0,
      exports: 0,
      failures: 0,
      droppedSpans: 0,
      lastError: null,
      openUntil: null,
    }
  }
}

export class NoopObservabilityProvider implements ObservabilityProvider {
  readonly name = 'noop'
  readonly recorder: TraceRecorder = new NoopTraceRecorder()
  readonly reader: ObservabilityReader = new NoopObservabilityReader()

  async shutdown(): Promise<void> {}
}

export const noopProvider: ObservabilityProvider = new NoopObservabilityProvider()
