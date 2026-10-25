/**
 * The shared poll/deadline timer: a real `setTimeout`. Host independent and
 * dependency free, so every module that waits defaults to it — the report
 * flow's `awaitReportAck` (`report-delivery.ts`), the verified screen poll
 * and the post-exit liveness check (`tmux.ts`). Tests inject a poll clock
 * instead and compress all of these waits together.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
