import { context } from 'esbuild'
import { cp, mkdir, readFile, watch, writeFile } from 'node:fs/promises'
import { serve } from './serve.mjs'

await mkdir('dist/assets', { recursive: true })
await cp('public', 'dist', { recursive: true })
async function updatePage() {
  await writeFile('dist/index.html', await readFile('index.html', 'utf8'))
  await cp('style.css', 'dist/style.css')
}
await updatePage()
const build = await context({ entryPoints: ['src/main.ts'], outdir: 'dist/assets', bundle: true, splitting: true, format: 'esm', target: ['es2022'], sourcemap: true })
await build.watch()
const server = serve('dist', Number(process.env.PORT ?? 4173))
const stop = new AbortController()
for (const file of ['index.html', 'style.css']) {
  void (async () => {
    try { for await (const event of watch(file, { signal: stop.signal })) await updatePage() }
    catch (error) { if (error.name !== 'AbortError') console.error(error) }
  })()
}
process.on('SIGINT', async () => { stop.abort(); server.close(); await build.dispose(); process.exit(0) })
console.log('Source changes rebuild automatically; refresh the page to view changes.')
