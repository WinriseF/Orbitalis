import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
const read = p => readFileSync(p)
const text = p => read(p).toString('utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const base = 'dist/media/cinematic/'
const scene = JSON.parse(text(base+'scene.json'))
function model(spec) {
  const bytes = Buffer.concat(spec.files.map(file => {
    assert.ok(/^[a-zA-Z0-9_.-]+$/.test(file.name))
    const bytes = read(base + file.name)
    assert.equal(bytes.length, file.bytes)
    assert.ok(bytes.length <= 20 * 1024 * 1024, 'Every model chunk is at most 20 MiB')
    assert.equal(hash(bytes), file.sha256)
    return bytes
  }))
  assert.equal(bytes.length, spec.bytes)
  assert.equal(hash(bytes), spec.sha256)
  assert.equal(bytes.readUInt32LE(0), 0x46546c67)
  assert.equal(bytes.readUInt32LE(4), 2)
  assert.equal(bytes.readUInt32LE(8), bytes.length)
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString())
  assert.ok((json.images ?? []).every(image => Number.isInteger(image.bufferView) && !image.uri))
  assert.ok(json.buffers.every(buffer => !buffer.uri))
  const triangles = json.meshes.reduce((sum, mesh) => sum + mesh.primitives.reduce((n, primitive) => n + json.accessors[primitive.indices].count / 3, 0), 0)
  return {bytes,json,triangles}
}
const planet = model(scene.model), station = model(scene.station.model)
assert.equal(planet.bytes.length, 181207568)
assert.equal(hash(planet.bytes), '1522f5617420faf22cf1558d40e6a3dd8f8d525e3246bac1a9861db3919e46b9')
assert.equal(planet.json.meshes.length, 1)
assert.equal(planet.json.materials.length, 1)
assert.equal(planet.json.images.length, 1)
assert.equal(planet.triangles, 16128)
assert.ok(planet.json.nodes.some(node => node.name === 'Planet_Core'))
assert.ok(!planet.json.nodes.some(node => /rock|asteroid/i.test(node.name)))
const planetMaterial = planet.json.materials.find(material => material.name === 'Planet_Baked_Color')
const planetImage = planet.json.images[planet.json.textures[planetMaterial.pbrMetallicRoughness.baseColorTexture.index].source]
const planetImageView = planet.json.bufferViews[planetImage.bufferView]
const planetImageStart = 20 + planet.bytes.readUInt32LE(12) + 8 + (planetImageView.byteOffset ?? 0)
const planetImageBytes = planet.bytes.subarray(planetImageStart, planetImageStart + planetImageView.byteLength)
assert.equal(planetImage.mimeType, 'image/png')
assert.equal(planetImageBytes.readUInt32BE(16), 15360)
assert.equal(planetImageBytes.readUInt32BE(20), 7680)
assert.equal(planetImageBytes.length, 180706567)
assert.equal(hash(planetImageBytes), 'ac70232759343add6010a74618390d1bbd64e4e1ff7ff651c65c5578e758a10a')
assert.deepEqual(scene.textureSource.dimensions, [15360, 7680])
assert.equal(scene.textureSource.bytes, 180706567)
assert.equal(scene.textureSource.sha256, hash(planetImageBytes))
assert.equal(scene.textureSource.embeddedVerbatim, true)
assert.equal(station.bytes.length, 21630136)
assert.equal(hash(station.bytes), '8ebabb6f21116ed375971a446ea5d62be0d34ad6fd1a04f98360e4f375e6c820')
assert.equal(station.json.meshes.length, 66)
assert.equal(station.json.materials.length, 13)
assert.equal((station.json.images ?? []).length, 0)
assert.equal(station.triangles, 429760)
assert.equal(scene.station.motion.spinRadiansPerSecond,0)
assert.deepEqual(scene.station.rotor,{nodeName:'Ring_Rotor',axis:[0,1,0],radiansPerSecond:.1})
for (const name of ['Ring_Rotor','Station_Fixed']) assert.ok(station.json.nodes.some(node=>node.name===name))
assert.ok(!scene.asteroids || scene.asteroids.length === 0)
assert.ok(!scene.prototypes || scene.prototypes.length === 0)
assert.deepEqual(scene.station.motion.inwardAxis,[0,-1,0])
assert.ok(scene.station.motion.facePlanetCenter)
assert.equal(scene.station.motion.orbit.radiansPerSecond,.04)
for (const body of [scene.planet, scene.station]) {
  assert.ok([...body.position,...body.quaternion,...body.scale].every(Number.isFinite))
  assert.ok(body.scale.every(value=>value>0))
}
for (const node of planet.json.nodes) {
  if (node.mesh === undefined) continue
  assert.deepEqual(node.translation ?? [0,0,0], [0,0,0])
  assert.deepEqual(node.rotation ?? [0,0,0,1], [0,0,0,1])
  assert.deepEqual(node.scale ?? [1,1,1], [1,1,1])
}
let runtimeBytes = 0
const runtimeNames = new Set(scene.runtimeAssets)
for (const name of runtimeNames) {
  assert.ok(/^[a-zA-Z0-9_.-]+$/.test(name))
  const bytes = read(base+name)
  assert.ok(bytes.length > 1000)
  assert.ok(bytes.length < 25 * 1024 * 1024, 'Static asset must stay below 25 MiB')
  runtimeBytes += bytes.length
}
for (const file of [...scene.model.files,...scene.station.model.files]) assert.ok(runtimeNames.has(file.name))
assert.deepEqual(new Set(readdirSync(base)),runtimeNames, 'Only current runtime assets are shipped')
assert.ok(runtimeBytes < 200 * 1024 * 1024)
assert.equal(scene.background, 'space_subtle.webp')
assert.equal(scene.fallback, 'planet_fallback.webp')
const html = text('dist/index.html')
for (const [, url] of html.matchAll(/(?:src|href)="(\.\/[^"#]*)"/g)) assert.ok(existsSync(resolve('dist', url)), `Missing asset: ${url}`)
assert.ok(html.includes('lang="zh-CN"'))
assert.ok(html.includes('./media/cinematic/planet_fallback.webp'))
assert.ok(!html.includes('/media/lunar-core/'))
for (const id of ['lunar-surface','lunar-canvas','lunar-poster','rotation-toggle','reset-view','scene-status','scene-mode','rotation-label','rotation-icon','instructions','scene-resolution','zoom-in','zoom-out','zoom-level']) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id)
const meta = JSON.parse(text('bundle-meta.json'))
for (const [path, output] of Object.entries(meta.outputs)) {
  assert.ok(existsSync(path), `Missing bundle ${path}`)
  for (const item of output.imports) { assert.ok(!item.external, `External bundle import ${item.path}`); assert.ok(existsSync(item.path) || existsSync(resolve(dirname(path),item.path)), `Missing import ${item.path}`) }
}
assert.ok(Object.keys(meta.inputs).some(path => path.includes('three.module')))
assert.ok(Object.keys(meta.inputs).some(path => path.includes('GLTFLoader')))
assert.ok(Object.keys(meta.inputs).some(path => path.endsWith('src/station-drag.ts')), 'Station picking and orbit-drag math are bundled')
assert.ok(html.includes('拖空间站'), 'Station drag instructions are visible')
assert.ok(!html.match(/<script[^>]+src="https?:/))
for (const name of readdirSync('dist/assets').filter(x=>x.endsWith('.js'))) assert.ok(!text(`dist/assets/${name}`).match(/(?:from\s*|import\s*\()\s*["']https?:/))
console.log(JSON.stringify({result:'passed',planet:{bytes:planet.bytes.length,triangles:planet.triangles,texture:[15360,7680],textureBytes:planetImageBytes.length,originalPNGBytesPreserved:true},station:{bytes:station.bytes.length,triangles:station.triangles,meshes:station.json.meshes.length,materials:station.json.materials.length,approvedDetailRetainedWithBearingRefinement:true},asteroids:0,runtimeBytes,bundledImports:'all local',assetPaths:'all exist',controls:'all present',note:'Static and offline checks do not claim WebGL/GPU rendering verification.'},null,2))
