import type { FrameworkAdapter } from './types'
import { ConfigError } from '../utils/errors'

const adapters: FrameworkAdapter[] = []

export function registerAdapter(adapter: FrameworkAdapter): void {
  adapters.push(adapter)
}

export function getRegisteredAdapters(): readonly FrameworkAdapter[] {
  return adapters
}

export function resetRegistry(): void {
  adapters.length = 0
}

export async function detectFramework(
  projectDir: string,
  hint?: string,
): Promise<FrameworkAdapter> {
  if (adapters.length === 0) {
    throw new ConfigError('No framework adapters registered.')
  }

  if (hint) {
    const match = adapters.find(a => a.name === hint)
    if (!match) {
      throw new ConfigError(
        `Framework hint "${hint}" does not match any registered adapter. `
        + `Available: ${adapters.map(a => a.name).join(', ')}`,
      )
    }
    return match
  }

  const scores = await Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      confidence: await adapter.detect(projectDir),
    })),
  )

  const best = scores.reduce((a, b) => (b.confidence > a.confidence ? b : a))

  if (best.confidence === 0) {
    throw new ConfigError(
      `No framework detected for ${projectDir}. `
      + `Registered adapters: ${adapters.map(a => a.name).join(', ')}`,
    )
  }

  return best.adapter
}
