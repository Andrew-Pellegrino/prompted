// Static files served from inside the Worker bundle.
//
// Why not Cloudflare's static-assets upload: that upload authenticates with a short-lived ticket,
// and the credential proxy used by Claude Code cloud sessions replaces it with the API token, so the
// upload is refused. Packaging the files into the script deploys through the ordinary API path.
// The object returned here has the same fetch() shape as a real ASSETS binding, so the rest of the
// Worker does not care which one it gets.
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', ico: 'image/x-icon', webp: 'image/webp' };
export const contentType = (path) => TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';

export function embeddedAssets(files) {
  const body = (f) => (f.b64 !== undefined ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.text);
  const respond = (path, status, method) => {
    const f = files[path];
    const html = path.endsWith('.html');
    return new Response(method === 'HEAD' ? null : body(f), { status, headers: { 'content-type': contentType(path), 'cache-control': html || path.startsWith('/data/') || path.startsWith('/index/') || path.startsWith('/admin/') ? 'public, max-age=0, must-revalidate' : 'public, max-age=3600', etag: `"${f.hash}"` } });
  };
  return {
    async fetch(request) {
      const url = new URL(typeof request === 'string' ? request : request.url);
      const method = typeof request === 'string' ? 'GET' : request.method;
      if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
      if (path.endsWith('/index.html')) return Response.redirect(url.origin + path.slice(0, -10) + url.search, 308);
      const file = path.endsWith('/') ? path + 'index.html' : path;
      if (files[file]) {
        const inm = typeof request === 'string' ? null : request.headers.get('if-none-match');
        if (inm && inm === `"${files[file].hash}"`) return new Response(null, { status: 304, headers: { etag: inm } });
        return respond(file, 200, method);
      }
      if (!path.endsWith('/') && files[path + '/index.html']) return Response.redirect(url.origin + path + '/' + url.search, 308);
      return files['/404.html'] ? respond('/404.html', 404, method) : new Response('Not found', { status: 404 });
    },
  };
}
