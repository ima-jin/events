import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createReport(directory) {
  const startedAt = new Date().toISOString();
  const timestamp = startedAt.replaceAll(':', '-').replaceAll('.', '_');
  return {
    file: join(directory, `events-rehearsal-dev-${timestamp}.json`),
    started: performance.now(),
    data: { version: 1, target: 'dev', startedAt, status: 'fail', durationMs: 0, steps: [] },
  };
}

function step(report, label, started, status) {
  if (report) report.data.steps.push({
    label, status, durationMs: Math.round(performance.now() - started),
  });
}

/** Labels are caller-owned constants; never include arguments, output, or errors. */
export function timedCommand(run, report) {
  return (tool, args, options = {}) => {
    const started = performance.now();
    let status = 'fail';
    try {
      const result = run(tool, args, options);
      status = 'pass';
      return result;
    } finally {
      step(report, options.step ?? 'Private subprocess', started, status);
    }
  };
}

export async function timedPhase(report, label, operation) {
  const started = performance.now();
  let status = 'fail';
  try {
    const result = await operation();
    status = 'pass';
    return result;
  } finally {
    step(report, label, started, status);
  }
}

export function finishReport(report, result, decision) {
  if (report) {
    report.data.status = result === 0 ? 'pass' : 'fail';
    report.data.durationMs = Math.round(performance.now() - report.started);
    if (decision) report.data.decision = decision;
    writeFileSync(report.file, `${JSON.stringify(report.data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
}
