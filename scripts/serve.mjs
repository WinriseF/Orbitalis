import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export function serve(directory = 'dist', port = 4173) {
  const root = resolve(directory)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bin': 'application/octet-stream' }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      const path = resolve(root, '.' + decodeURIComponent(url.pathname), url.pathname.endsWith('/') ? 'index.html' : '')
      if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return }
      const info = await stat(path)
      if (!info.isFile()) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' })
      if (request.method === 'HEAD') response.end()
      else createReadStream(path).on('error', () => response.destroy()).pipe(response)
    } catch { response.writeHead(404).end('Not found') }
  })
  server.listen(port, '127.0.0.1', () => console.log(`Orbitalis: http://localhost:${port}/`))
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve('dist', Number(process.env.PORT ?? 4173))
