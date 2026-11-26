// The public samples fit in memory. Generated courses use the same byte offsets
// to read just the requested part from R2.
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  return { start, end };
}

export async function sampleVideo(request, assets) {
  const range = request.method === 'GET' && request.headers.get('Range');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('Range');
  requestHeaders.delete('If-Range');
  const asset = await assets.fetch(new Request(request, { headers: requestHeaders }));
  if (asset.status !== 200 || !asset.headers.get('Content-Type')?.startsWith('video/mp4')) return asset;

  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  const validator = request.headers.get('If-Range');
  const current = !validator || (!validator.startsWith('W/') &&
    (validator === headers.get('ETag') || validator === headers.get('Last-Modified')));
  if (!range || !current) return new Response(asset.body, { headers });

  const bytes = await asset.arrayBuffer();
  const part = byteRange(range, bytes.byteLength);
  if (!part) {
    headers.set('Content-Range', 'bytes */' + bytes.byteLength);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${part.start}-${part.end}/${bytes.byteLength}`);
  headers.set('Content-Length', String(part.end - part.start + 1));
  return new Response(bytes.slice(part.start, part.end + 1), { status: 206, headers });
}
