import { randomUUID } from 'node:crypto'

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function clean(value) {
  return String(value ?? '').replaceAll('"', '\\"').replaceAll('\n', ' ')
}

export function createLogger(service = 'dsh-multiuser') {
  function write(level, event, fields = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      event,
      level: LEVELS.has(level) ? level : 'info',
      trace_id: fields.traceId ?? randomUUID(),
      service,
      env: process.env.NODE_ENV ?? 'production',
      status: fields.status ?? 'ok',
      decision_reason: clean(fields.reason ?? ''),
    }
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'traceId' || key === 'reason' || value === undefined) continue
      if (['password', 'cookie', 'secret', 'token', 'authorization'].includes(key)) continue
      record[key] = value
    }
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
