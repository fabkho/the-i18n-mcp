import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: 'esm',
  target: 'node18',
  clean: true,
  dts: true,
  sourcemap: true,
  onSuccess: async () => {
    // tsdown generates hashed .d.ts names — create a stable index.d.ts redirect
    const { readdirSync, writeFileSync } = await import('node:fs')
    const files = readdirSync('dist')
    const indexDts = files.find(f => f.startsWith('index-') && f.endsWith('.d.ts'))
    if (indexDts) {
      writeFileSync('dist/index.d.ts', `export * from './${indexDts}';\n`)
    }
  },
})
