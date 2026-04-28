import { consola } from 'consola'

export const sharedArgs = {
  projectDir: {
    type: 'string' as const,
    alias: 'd',
    description: 'Project directory (default: cwd)',
  },
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON (default for non-TTY)',
    default: false,
  },
}

/** Output result — JSON for piped/--json, pretty-printed for TTY */
export function outputResult(data: unknown, args: { json?: boolean }): void {
  const json = JSON.stringify(data, null, 2)
  if (args.json || !process.stdout.isTTY) {
    process.stdout.write(json + '\n')
  } else {
    consola.log(json)
  }
}

/** Split a comma-separated string into a trimmed array, or return undefined */
export function splitList(val: string | undefined): string[] | undefined {
  if (!val) return undefined
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

/** Parse a JSON string with a user-friendly error */
export function parseJsonArg<T = Record<string, Record<string, string>>>(
  value: string,
  argName: string,
): T {
  try {
    return JSON.parse(value) as T
  } catch (err) {
    const detail = err instanceof SyntaxError ? err.message : String(err)
    throw new Error(`Invalid JSON in --${argName}: ${detail}`)
  }
}
