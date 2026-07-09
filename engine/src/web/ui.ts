// ============================================================================
// Shared UI: page layout, stylesheet, and the client-side helper bundle
// (fetch wrapper, formatters, chart renderers). Served as static strings —
// no build step, no CDN dependencies.
// ============================================================================

export const STYLESHEET = /* css */ `
:root {
  --bg: #f4f6f9; --panel: #ffffff; --ink: #1a2233; --muted: #66718a;
  --line: #e3e8f0; --brand: #1f4e8c; --brand-ink: #ffffff;
  --red: #c0392b; --amber: #b9770e; --green: #1e8449; --blue: #2471a3;
  --chip: #eef2f8;
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, 'Segoe UI', Roboto, sans-serif;
       background: var(--bg); color: var(--ink); }
a { color: var(--brand); text-decoration: none; }
.shell { display: flex; min-height: 100vh; }
nav.side { width: 208px; background: #142743; color: #cdd8ea; padding: 16px 0; flex-shrink: 0; }
nav.side .brand { font-weight: 700; color: #fff; padding: 4px 18px 14px; font-size: 15px; }
nav.side a { display: block; padding: 9px 18px; color: #cdd8ea; font-size: 13.5px; }
nav.side a.active, nav.side a:hover { background: #1f3a63; color: #fff; }
nav.side .sect { padding: 12px 18px 4px; font-size: 11px; text-transform: uppercase;
                 letter-spacing: .08em; color: #7f94b5; }
main { flex: 1; padding: 20px 26px; max-width: 1500px; }
.topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.topbar h1 { font-size: 19px; margin: 0; }
.topbar .who { color: var(--muted); font-size: 13px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.card .big { font-size: 24px; font-weight: 700; }
.card .sub { color: var(--muted); font-size: 12.5px; }
.card.alarm .big { color: var(--red); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
.grid3 { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; margin-top: 14px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.panel h2 { margin: 0 0 10px; font-size: 14px; }
table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
table.data th { text-align: left; padding: 7px 8px; border-bottom: 2px solid var(--line);
                color: var(--muted); font-size: 12px; white-space: nowrap; cursor: pointer; user-select: none; }
table.data td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.data tr:hover td { background: #f7f9fc; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11.5px; font-weight: 600; }
.badge.critical { background: #fdecea; color: var(--red); }
.badge.high { background: #fef5e7; color: var(--amber); }
.badge.medium { background: #eaf2fb; color: var(--blue); }
.badge.low { background: #eef2f8; color: var(--muted); }
.badge.st { background: var(--chip); color: var(--ink); }
.badge.won, .badge.ready { background: #e9f7ef; color: var(--green); }
.badge.lost, .badge.draft { background: #fdecea; color: var(--red); }
.deadline-red { color: var(--red); font-weight: 700; }
.btn { display: inline-block; border: 1px solid var(--line); background: var(--panel);
       color: var(--ink); border-radius: 7px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
.btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
.btn.danger { background: var(--red); border-color: var(--red); color: #fff; }
.btn.small { padding: 4px 9px; font-size: 12px; }
.btn:disabled { opacity: .5; cursor: default; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: end; }
.filters label { display: flex; flex-direction: column; font-size: 11.5px; color: var(--muted); gap: 3px; }
.filters select, .filters input, .modal select, .modal input, .modal textarea, textarea.note {
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.bulkbar { display: none; gap: 8px; align-items: center; background: #142743; color: #fff;
           padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; }
.bulkbar.on { display: flex; }
.hbar { display: grid; grid-template-columns: 150px 1fr 90px; gap: 8px; align-items: center;
        font-size: 12.5px; margin: 5px 0; }
.hbar .track { background: var(--chip); border-radius: 5px; height: 16px; }
.hbar .fill { background: var(--brand); border-radius: 5px; height: 16px; min-width: 2px; }
.hbar.alt .fill { background: var(--amber); }
.feed { list-style: none; margin: 0; padding: 0; font-size: 12.5px; }
.feed li { padding: 7px 0; border-bottom: 1px solid var(--line); }
.feed .meta { color: var(--muted); font-size: 11.5px; }
.threecol { display: grid; grid-template-columns: 300px 1fr 340px; gap: 14px; align-items: start; }
@media (max-width: 1200px) { .threecol { grid-template-columns: 1fr 1fr; } .threecol > :first-child { grid-column: 1 / -1; } }
@media (max-width: 900px) { .threecol, .grid2, .grid3 { grid-template-columns: 1fr; } }
.kv { font-size: 13px; } .kv div { display: flex; justify-content: space-between; padding: 3.5px 0; }
.kv dt { color: var(--muted); } .kv dd { margin: 0; text-align: right; }
.bignum { font-size: 30px; font-weight: 800; color: var(--green); }
.letter { white-space: pre-wrap; font: 12px/1.5 ui-monospace, Menlo, monospace; background: #fbfcfe;
          border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 420px; overflow: auto; }
.checklist { list-style: none; padding: 0; margin: 8px 0; font-size: 13px; }
.checklist li { padding: 4px 0; }
.checklist .ok::before { content: '✓ '; color: var(--green); font-weight: 700; }
.checklist .missing::before { content: '✗ '; color: var(--red); font-weight: 700; }
.timeline { list-style: none; padding: 0; margin: 0; }
.timeline li { display: grid; grid-template-columns: 150px 130px 1fr; gap: 10px;
               padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.timeline .when { color: var(--muted); font-size: 12px; }
.steps { display: flex; gap: 6px; margin-bottom: 16px; }
.steps span { padding: 6px 12px; border-radius: 16px; background: var(--chip); font-size: 12.5px; color: var(--muted); }
.steps span.on { background: var(--brand); color: #fff; }
.modal-back { position: fixed; inset: 0; background: rgba(15,25,45,.45); display: none;
              align-items: center; justify-content: center; z-index: 40; }
.modal-back.on { display: flex; }
.modal { background: #fff; border-radius: 10px; padding: 18px; width: 430px; max-width: 92vw; }
.modal h3 { margin: 0 0 12px; font-size: 15px; }
.modal .row { margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--muted); }
.modal .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.toast { position: fixed; bottom: 18px; right: 18px; background: #142743; color: #fff;
         padding: 10px 16px; border-radius: 8px; font-size: 13px; display: none; z-index: 60; }
.toast.on { display: block; }
.toast.err { background: var(--red); }
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.login { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 28px; width: 340px; }
.login h1 { font-size: 18px; margin: 0 0 16px; }
.login label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
.login input { width: 100%; border: 1px solid var(--line); border-radius: 7px; padding: 9px; font-size: 14px; margin-top: 4px; }
.login .err { color: var(--red); font-size: 12.5px; min-height: 16px; margin: 6px 0; }
svg text { font: 10.5px -apple-system, sans-serif; fill: var(--muted); }
.legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; }
.drill { cursor: pointer; }
.navdot { display: none; background: var(--red); color: #fff; border-radius: 9px;
          font-size: 10.5px; padding: 1px 6px; margin-left: 6px; font-weight: 700; }
.navdot.on { display: inline-block; }
`;

export const CLIENT_JS = /* js */ `
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtDate = (d) => d ? String(d).slice(0, 10) : '—';
const fmtWhen = (d) => d ? new Date(d).toLocaleString() : '—';

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg;
  t.className = 'toast on' + (isErr ? ' err' : '');
  setTimeout(() => t.className = 'toast', 3200);
}
function openModal(id) { $('#' + id).classList.add('on'); }
function closeModal(id) { $('#' + id).classList.remove('on'); }

// ---- charts ---------------------------------------------------------------
function hbarChart(el, items, opts) {
  const max = Math.max(...items.map((i) => i.value), 1);
  el.innerHTML = items.map((i) =>
    '<div class="hbar' + ((opts||{}).alt ? ' alt' : '') + '">' +
    '<span title="' + esc(i.label) + '">' + esc(String(i.label).length > 22 ? String(i.label).slice(0,21) + '…' : i.label) + '</span>' +
    '<span class="track"><span class="fill" style="width:' + (i.value / max * 100).toFixed(1) + '%"></span></span>' +
    '<span class="num">' + ((opts||{}).money === false ? i.value : usd(i.value)) + '</span></div>'
  ).join('') || '<div class="sub">no data</div>';
}

function lineChart(el, labels, series) {
  const W = 640, H = 200, PL = 52, PB = 26, PT = 10, PR = 10;
  const all = series.flatMap((s) => s.values);
  const max = Math.max(...all, 1);
  const x = (i) => labels.length < 2 ? PL : PL + (W - PL - PR) * i / (labels.length - 1);
  const y = (v) => PT + (H - PT - PB) * (1 - v / max);
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%">';
  for (let g = 0; g <= 4; g++) {
    const gy = PT + (H - PT - PB) * g / 4;
    svg += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="#e3e8f0"/>' +
           '<text x="' + (PL - 6) + '" y="' + (gy + 3) + '" text-anchor="end">$' + Math.round(max * (1 - g / 4)).toLocaleString() + '</text>';
  }
  const step = Math.max(1, Math.ceil(labels.length / 8));
  labels.forEach((l, i) => { if (i % step === 0)
    svg += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(String(l).slice(5)) + '</text>'; });
  for (const s of series) {
    const pts = s.values.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    svg += '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2.2"/>';
    s.values.forEach((v, i) => { svg += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="2.6" fill="' + s.color + '"/>'; });
  }
  svg += '</svg>';
  el.innerHTML = svg + '<div class="legend">' +
    series.map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>').join('') + '</div>';
}

function donutChart(el, items) {
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  const colors = ['#1f4e8c','#b9770e','#1e8449','#c0392b','#7d3c98','#2471a3','#117a65','#a04000','#5d6d7e'];
  const R = 70, C = 90; let angle = -Math.PI / 2;
  let svg = '<svg viewBox="0 0 180 180" style="width:190px">';
  items.forEach((it, idx) => {
    const frac = it.value / total, next = angle + frac * 2 * Math.PI;
    const large = frac > .5 ? 1 : 0;
    if (frac > 0.999) {
      svg += '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="' + colors[idx % 9] + '"/>';
    } else if (frac > 0) {
      svg += '<path d="M' + C + ',' + C + ' L' + (C + R * Math.cos(angle)).toFixed(1) + ',' + (C + R * Math.sin(angle)).toFixed(1) +
        ' A' + R + ',' + R + ' 0 ' + large + ' 1 ' + (C + R * Math.cos(next)).toFixed(1) + ',' + (C + R * Math.sin(next)).toFixed(1) +
        ' Z" fill="' + colors[idx % 9] + '"/>';
    }
    angle = next;
  });
  svg += '<circle cx="90" cy="90" r="40" fill="#fff"/></svg>';
  el.innerHTML = '<div style="display:flex;gap:16px;align-items:center">' + svg +
    '<div>' + items.map((it, idx) =>
      '<div style="font-size:12.5px;margin:3px 0"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' +
      colors[idx % 9] + ';margin-right:6px"></i>' + esc(it.label) + ' — ' + usd(it.value) +
      ' (' + Math.round(it.value / total * 100) + '%)</div>').join('') + '</div></div>';
}

// ---- CSV download of any array of flat objects ------------------------------
function downloadCsv(rows, fileName) {
  if (!rows.length) return toast('nothing to export', true);
  const cols = Object.keys(rows[0]);
  const cell = (v) => v == null ? '' : /[",\\n]/.test(String(v)) ? '"' + String(v).replaceAll('"','""') + '"' : String(v);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = fileName; a.click();
}
const prBadge = (p) => '<span class="badge ' + esc(p) + '">' + esc(p) + '</span>';
const stBadge = (s) => '<span class="badge st ' + esc(s) + '">' + esc(String(s).replaceAll('_',' ')) + '</span>';

// unread notification count + client-settings nav target (best-effort)
(async () => {
  const dot = document.getElementById('nav-unread');
  if (!dot) return;
  try {
    const { count } = await api('/api/notifications/unread-count');
    if (count > 0) { dot.textContent = count; dot.classList.add('on'); }
    const link = document.getElementById('nav-client-settings');
    if (link) {
      const me = await api('/api/whoami');
      if (me.clientId) link.href = '/admin/client/' + me.clientId;
      else link.style.display = 'none'; // tenant-wide admins use the client list
    }
  } catch { /* not logged in */ }
})();
`;

export function layout(opts: {
  title: string; active: string; userName: string; role: string; body: string; script?: string;
}): string {
  const isTenantAdmin = ['super_admin', 'tenant_admin'].includes(opts.role);
  const isAdmin = isTenantAdmin || opts.role === 'client_admin';
  const items: Array<[string, string, string] | null> = [
    ['dashboard', '/dashboard', 'Dashboard'],
    ['queue', '/queue', 'Case Queue'],
    ['builder', '/builder', 'Appeal Builder'],
    ['notifications', '/notifications', 'Notifications <span id="nav-unread" class="navdot"></span>'],
    ['_', '', 'Reports'],
    ['payers', '/reports/payers', 'Payer Performance'],
    ['denials', '/reports/denials', 'Denial Analytics'],
    ['reconciliation', '/reports/reconciliation', 'Reconciliation'],
    ['workload', '/reports/workload', 'Team Workload'],
    isAdmin ? ['_', '', 'Admin'] : null,
    isAdmin ? ['rules', '/rules', 'Automation Rules'] : null,
    isTenantAdmin ? ['admin', '/admin', 'Tenant Overview'] : null,
    isTenantAdmin ? ['admin-users', '/admin/users', 'User Management'] : null,
    isAdmin ? ['admin-client', '#client-settings', 'Client Settings'] : null,
    isAdmin ? ['compliance', '/compliance', 'Audit & Compliance'] : null,
  ];
  const nav = items.filter((x): x is [string, string, string] => x != null)
    .map(([key, href, label]) =>
      key === '_' ? `<div class="sect">${label}</div>`
        : `<a href="${href}" ${href === '#client-settings' ? 'id="nav-client-settings"' : ''} class="${key === opts.active ? 'active' : ''}">${label}</a>`,
    ).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} — RCM Recovery</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body><div class="shell">
<nav class="side"><div class="brand">RCM Recovery</div>${nav}
<div class="sect">Session</div>
<a href="#" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login');return false">Sign out</a>
</nav>
<main>
<div class="topbar"><h1>${opts.title}</h1>
<div class="who">${opts.userName} · ${opts.role.replaceAll('_', ' ')}</div></div>
${opts.body}
</main></div>
<div id="toast" class="toast"></div>
<script src="/assets/app.js"></script>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body></html>`;
}

export function loginPage(error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in — RCM Recovery</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body><div class="login-wrap"><form class="login" id="f">
<h1>RCM Recovery — Sign in</h1>
<label>Email<input type="email" name="email" required autofocus></label>
<label>Password<input type="password" name="password" required></label>
<label id="totp-row" style="display:none">Authenticator code<input name="totp" inputmode="numeric" autocomplete="one-time-code"></label>
<div id="enroll" class="sub" style="display:none;margin-bottom:8px"></div>
<div id="pwchange" style="display:none">
  <label>New password<input type="password" name="newPassword"></label>
</div>
<div class="err" id="err">${error ?? ''}</div>
<button class="btn primary" style="width:100%" id="go">Sign in</button>
</form></div>
<script>
const f = document.getElementById('f');
let mode = 'login';
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(f);
  const err = document.getElementById('err');
  if (mode === 'pwchange') {
    const res = await fetch('/api/change-password', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fd.get('email'), oldPassword: fd.get('password'),
        newPassword: fd.get('newPassword') }) });
    const body = await res.json();
    if (!res.ok) { err.textContent = body.error; return; }
    err.textContent = 'password updated — sign in with your new password';
    document.getElementById('pwchange').style.display = 'none';
    f.password.value = ''; mode = 'login';
    document.getElementById('go').textContent = 'Sign in';
    return;
  }
  const res = await fetch('/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: fd.get('email'), password: fd.get('password'),
      totp: fd.get('totp') || undefined }) });
  const body = await res.json();
  if (res.ok) { location.href = '/dashboard'; return; }
  err.textContent = body.error || 'sign in failed';
  if (body.mfaRequired || body.mfaEnroll) {
    document.getElementById('totp-row').style.display = '';
    if (body.mfaEnroll) {
      const en = document.getElementById('enroll');
      en.style.display = '';
      en.innerHTML = 'Add this secret to your authenticator app, then enter a code:<br>' +
        '<code style="user-select:all">' + body.secret + '</code>';
    }
  }
  if (body.passwordExpired) {
    document.getElementById('pwchange').style.display = '';
    document.getElementById('go').textContent = 'Change password';
    mode = 'pwchange';
  }
});
</script></body></html>`;
}
