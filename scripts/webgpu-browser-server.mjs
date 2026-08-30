import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal dependency-free static server for running the WebGPU browser
 * integration test (`test/webgpu.browser.html`). The test page imports ES
 * modules from `../src`, so it must be served over HTTP rather than opened as
 * a `file://` URL.
 *
 * Usage:
 *   npm run test:webgpu:serve
 * then open http://127.0.0.1:8123/test/webgpu.browser.html in Chrome or Edge
 * with WebGPU enabled.
 */

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');
const port = Number(process.env.PORT ?? 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = normalize(join(root, decoded));
  if (target !== root && !target.startsWith(root + '/')) {
    return null;
  }
  return target;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = request.url.split('?')[0];
    const target = safePath(pathname === '/' ? '/test/webgpu.browser.html' : pathname);
    if (target === null) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }

    response.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream'
    });
    createReadStream(target).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(500).end('Internal server error');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`WebGPU browser test server: http://127.0.0.1:${port}/test/webgpu.browser.html`);
});
