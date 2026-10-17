export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'x-zm': '1' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    if (data.code) err.code = data.code;
    if (data.deal) err.deal = data.deal;
    throw err;
  }
  return data;
}

export const qs = (obj) =>
  '?' +
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
