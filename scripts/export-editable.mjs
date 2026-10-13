import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const base = new URL('../public/media/cinematic/', import.meta.url)
const output = new URL('../.release/editable/', import.meta.url)
const scene = JSON.parse(await readFile(new URL('scene.json', base), 'utf8'))
await mkdir(output, { recursive: true })
for (const [name, model] of [['planet', scene.model], ['station', scene.station.model]]) {
  const bytes = Buffer.concat(await Promise.all(model.files.map(file => readFile(new URL(file.name, base)))))
  if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error(`${name} model integrity check failed`)
  await writeFile(new URL(`${name}.glb`, output), bytes)
}
console.log('Exact v14 GLBs exported to .release/editable/ for Blender import.')
