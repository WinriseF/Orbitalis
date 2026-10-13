import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist/assets', { recursive: true })
await cp('public', 'dist', { recursive: true })
await cp('style.css', 'dist/style.css')
await cp('LICENSE', 'dist/LICENSE.txt')
await cp('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md')
await cp('licenses', 'dist/licenses', { recursive: true })
const result = await build({
  entryPoints: ['src/main.ts'], outdir: 'dist/assets', entryNames: '[name]-[hash]',
  bundle: true, splitting: true, format: 'esm', target: ['es2022'],
  minify: true, sourcemap: false, metafile: true, legalComments: 'eof',
})
const main = Object.entries(result.metafile.outputs).find(([, entry]) => entry.entryPoint === 'src/main.ts')?.[0]
if (!main) throw new Error('Missing browser entry bundle')
const html = await readFile('index.html', 'utf8')
await writeFile('dist/index.html', html.replace('./assets/main.js', `./${main.replace(/^dist\//, '')}`))
await writeFile('bundle-meta.json', JSON.stringify(result.metafile, null, 2))
console.log('Built Orbitalis into dist/.')
