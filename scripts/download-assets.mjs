import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const spec = JSON.parse(await readFile(new URL('../assets-manifest.json', import.meta.url), 'utf8'))
const directory = new URL('../public/media/cinematic/', import.meta.url)
const scene = JSON.parse(await readFile(new URL('scene.json', directory), 'utf8'))
const files = [...scene.model.files, ...scene.station.model.files]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function complete() {
  try {
    for (const file of files) {
      const bytes = await readFile(new URL(file.name, directory))
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) return false
    }
    return true
  } catch { return false }
}
if (await complete()) { console.log('The v14 model assets are already installed.'); process.exit(0) }
const temporary = await mkdtemp(join(tmpdir(), 'orbitalis-assets-'))
try {
  console.log(`Downloading model assets from ${spec.release} (${Math.round(spec.bytes / 1024 / 1024)} MiB)...`)
  const response = await fetch(spec.url)
  if (!response.ok) throw new Error(`Asset download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== spec.bytes || digest(bytes) !== spec.sha256) throw new Error('Asset archive SHA-256 mismatch')
  const archive = join(temporary, 'models.tar.gz')
  await writeFile(archive, bytes)
  await mkdir(directory, { recursive: true })
  await promisify(execFile)('tar', ['-xzf', archive, '-C', fileURLToPath(directory), ...files.map(file => file.name)])
  if (!await complete()) throw new Error('Installed model integrity check failed')
  console.log('The original v14 model assets are ready.')
} finally { await rm(temporary, { recursive: true, force: true }) }
