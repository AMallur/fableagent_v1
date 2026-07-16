// ============================================================================
// Enterprise admin pages: tenant overview (+SSO), user management, client
// detail (settings / payers / contracts / integration / billing / onboarding),
// compliance center (audit / PHI / jobs / exports), and the invite-accept page.
// ============================================================================

export function acceptInvitePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Accept invitation</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body><div class="login-wrap"><form class="login" id="f">
<h1>Set your password</h1>
<div class="sub" style="margin-bottom:10px">Minimum 12 characters with at least 3 of:
uppercase, lowercase, digit, symbol.</div>
<label>New password<input type="password" name="password" required autofocus></label>
<label>Confirm<input type="password" name="confirm" required></label>
<div class="err" id="err"></div>
<button class="btn primary" style="width:100%">Activate account</button>
</form></div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const err = document.getElementById('err');
  if (fd.get('password') !== fd.get('confirm')) { err.textContent = 'passwords do not match'; return; }
  const token = new URLSearchParams(location.search).get('token');
  const res = await fetch('/api/accept-invite', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: fd.get('password') }) });
  const body = await res.json();
  if (res.ok) { location.href = '/login'; }
  else err.textContent = body.error || 'activation failed';
});
</script></body></html>`;
}

// ---------------------------------------------------------------------------

export const ADMIN_BODY = `
<div class="cards">
  <div class="card"><h3>Clients</h3><div class="big" id="k-clients">—</div></div>
  <div class="card"><h3>AUM in recovery</h3><div class="big" id="k-aum">—</div></div>
  <div class="card"><h3>Recovered all time</h3><div class="big" id="k-rec">—</div></div>
  <div class="card"><h3>Active cases</h3><div class="big" id="k-cases">—</div></div>
  <div class="card"><h3>Users</h3><div class="big" id="k-users">—</div></div>
  <div class="card" id="health-card"><h3>System health</h3><div class="big" id="k-health">—</div>
    <div class="sub" id="k-health-sub"></div></div>
</div>
<div class="panel" style="margin-top:14px">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h2 style="margin:0">Clients</h2>
    <button class="btn primary" onclick="openModal('m-client')">+ Add client</button>
  </div>
  <table class="data" id="clients"><tbody></tbody></table>
</div>
<div class="panel" style="margin-top:14px"><h2>SSO / SAML 2.0</h2>
  <div class="filters">
    <label><input type="checkbox" id="sso-enabled"> enabled</label>
    <label>IdP entity ID<input id="sso-entity" style="width:220px"></label>
    <label>IdP SSO URL<input id="sso-url" style="width:260px"></label>
    <label>Group attribute<input id="sso-attr" value="groups" style="width:110px"></label>
    <label>Default role<select id="sso-role"><option>viewer</option><option>collector</option>
      <option>biller</option><option>client_admin</option></select></label>
  </div>
  <div class="row" style="margin:6px 0"><textarea id="sso-cert" rows="3" style="width:100%"
    placeholder="IdP x509 certificate (PEM)"></textarea></div>
  <div class="sub" style="margin-bottom:6px">Group → role mappings (one per line: group=role)</div>
  <textarea id="sso-map" rows="3" style="width:100%" placeholder="rcm-admins=tenant_admin"></textarea>
  <div style="margin-top:8px;display:flex;gap:10px;align-items:center">
    <button class="btn primary" id="sso-save">Save SSO configuration</button>
    <span class="sub" id="sso-links"></span>
  </div>
</div>
<div class="modal-back" id="m-client"><div class="modal"><h3>New client</h3>
  <div class="row">Client name<input id="nc-name"></div>
  <div class="row">Tax ID (TIN)<input id="nc-tax"></div>
  <div class="row">Group NPI<input id="nc-npi"></div>
  <div class="row">State<input id="nc-state" maxlength="2" style="width:60px"></div>
  <div class="row"><label><input type="checkbox" id="nc-baa">
    I acknowledge a Business Associate Agreement (BAA) is executed with this client</label></div>
  <div class="actions"><button class="btn" onclick="closeModal('m-client')">Cancel</button>
  <button class="btn primary" id="nc-go">Create client</button></div></div></div>`;

export const ADMIN_JS = `
async function load() {
  const d = await api('/api/admin/overview');
  $('#k-clients').textContent = d.totals.clients;
  $('#k-aum').textContent = usd(d.totals.aum);
  $('#k-rec').textContent = usd(d.totals.recovered);
  $('#k-cases').textContent = d.totals.activeCases;
  $('#k-users').textContent = d.totals.users;
  $('#k-health').textContent = d.health.status;
  $('#k-health').style.color = d.health.status === 'healthy' ? 'var(--green)' : 'var(--red)';
  $('#k-health-sub').textContent = d.health.failedJobs24h + ' failed jobs (24h) · ' +
    d.health.queuedEmails + ' queued emails · last nightly ' + (d.health.lastNightly ? fmtWhen(d.health.lastNightly) : 'never');
  $('#clients tbody').innerHTML =
    '<tr><th>Client</th><th>Subscription</th><th>BAA</th><th class="num">AUM</th>' +
    '<th class="num">Recovered</th><th class="num">Open cases</th><th class="num">Users</th>' +
    '<th>Onboarding</th><th></th></tr>' +
    d.clients.map((c) => '<tr><td><b>' + esc(c.name) + '</b><div class="sub">' +
      esc([c.specialty, c.state].filter(Boolean).join(' · ')) + '</div></td>' +
      '<td>' + stBadge(c.subscription) + '</td>' +
      '<td>' + (c.baaAcknowledged ? '<span class="badge won">signed</span>' : '<span class="badge lost">missing</span>') + '</td>' +
      '<td class="num">' + usd(c.aum) + '</td><td class="num">' + usd(c.recovered) + '</td>' +
      '<td class="num">' + c.openCases + '</td><td class="num">' + c.users + '</td>' +
      '<td>' + c.onboarding.done + '/' + c.onboarding.total + '</td>' +
      '<td><a class="btn small" href="/admin/client/' + c.clientId + '">Manage</a></td></tr>').join('');
}
$('#nc-go').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/clients', { method: 'POST', body: JSON.stringify({
      clientName: $('#nc-name').value, taxId: $('#nc-tax').value || undefined,
      npiGroup: $('#nc-npi').value || undefined, state: $('#nc-state').value || undefined,
      baaAcknowledged: $('#nc-baa').checked }) });
    closeModal('m-client'); toast('client created — onboarding checklist started');
    location.href = '/admin/client/' + r.clientId;
  } catch (e) { toast(e.message, true); }
});
async function loadSso() {
  const d = await api('/api/admin/sso');
  const c = d.config || {};
  $('#sso-enabled').checked = !!c.enabled;
  $('#sso-entity').value = c.idp_entity_id || '';
  $('#sso-url').value = c.idp_sso_url || '';
  $('#sso-attr').value = c.group_attribute || 'groups';
  $('#sso-role').value = c.default_role || 'viewer';
  $('#sso-cert').value = c.idp_certificate || '';
  $('#sso-map').value = (c.group_role_mappings || []).map((m) => m.group + '=' + m.role).join('\\n');
  $('#sso-links').innerHTML = 'SP metadata: <a href="' + d.metadataUrl + '" target="_blank">' +
    d.metadataUrl + '</a> · login: <code>' + d.loginUrl + '</code>';
}
$('#sso-save').addEventListener('click', async () => {
  const mappings = $('#sso-map').value.split('\\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [group, role] = l.split('='); return { group: group?.trim(), role: role?.trim() }; })
    .filter((m) => m.group && m.role);
  try {
    await api('/api/admin/sso', { method: 'POST', body: JSON.stringify({
      enabled: $('#sso-enabled').checked, idpEntityId: $('#sso-entity').value || null,
      idpSsoUrl: $('#sso-url').value || null, idpCertificate: $('#sso-cert').value || null,
      groupAttribute: $('#sso-attr').value || null, defaultRole: $('#sso-role').value,
      groupRoleMappings: mappings }) });
    toast('SSO configuration saved');
  } catch (e) { toast(e.message, true); }
});
load(); loadSso();`;

// ---------------------------------------------------------------------------

export const USERS_BODY = `
<div class="panel">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h2 style="margin:0">All users</h2>
    <button class="btn primary" onclick="openModal('m-invite')">+ Invite user</button>
  </div>
  <table class="data" id="users"><tbody></tbody></table>
</div>
<div class="panel" style="margin-top:14px"><h2 id="act-title">User activity</h2>
  <div class="sub" id="act-hint">select "activity" on a user to view their audit trail</div>
  <table class="data" id="activity"><tbody></tbody></table>
</div>
<div class="modal-back" id="m-invite"><div class="modal"><h3>Invite user</h3>
  <div class="row">Email<input id="iv-email" type="email"></div>
  <div class="row">First name<input id="iv-first"></div>
  <div class="row">Last name<input id="iv-last"></div>
  <div class="row">Role<select id="iv-role"><option>biller</option><option>collector</option>
    <option>viewer</option><option>client_admin</option><option>tenant_admin</option></select></div>
  <div class="row">Client scope<select id="iv-client"><option value="">tenant-wide</option></select></div>
  <div class="actions"><button class="btn" onclick="closeModal('m-invite')">Cancel</button>
  <button class="btn primary" id="iv-go">Send invite</button></div></div></div>`;

export const USERS_JS = `
let clients = [];
async function load() {
  const [users, overview] = await Promise.all([
    api('/api/admin/users'), api('/api/admin/overview')]);
  clients = overview.clients;
  $('#iv-client').innerHTML = '<option value="">tenant-wide</option>' +
    clients.map((c) => '<option value="' + c.clientId + '">' + esc(c.name) + '</option>').join('');
  $('#users tbody').innerHTML =
    '<tr><th>User</th><th>Role</th><th>Scope</th><th>Status</th><th>MFA</th>' +
    '<th>Last login</th><th class="num">Actions (30d)</th><th>Assign</th><th></th></tr>' +
    users.map((u) => '<tr><td><b>' + esc(u.name || u.email) + '</b><div class="sub">' + esc(u.email) + '</div></td>' +
      '<td>' + esc(u.role.replaceAll('_',' ')) + '</td>' +
      '<td>' + esc(u.clientName || 'tenant-wide') + '</td>' +
      '<td>' + stBadge(u.status) + (u.locked ? ' <span class="badge lost">locked</span>' : '') +
        (u.invitePending ? ' <span class="badge high">invite pending</span>' : '') + '</td>' +
      '<td>' + (u.mfaEnabled ? '✓' : '—') + '</td>' +
      '<td>' + (u.lastLogin ? fmtWhen(u.lastLogin) : 'never') + '</td>' +
      '<td class="num">' + u.actions30d + '</td>' +
      '<td><select class="assign" data-id="' + u.userId + '"><option value="">tenant-wide</option>' +
        clients.map((c) => '<option value="' + c.clientId + '"' +
          (u.clientId === c.clientId ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') +
      '</select></td>' +
      '<td><button class="btn small" data-act="' + u.userId + '">activity</button> ' +
      '<button class="btn small" data-reset="' + u.userId + '">reset</button> ' +
      (u.status !== 'inactive' ? '<button class="btn small danger" data-deact="' + u.userId + '">deactivate</button>' : '') +
      '</td></tr>').join('');
  $$('.assign').forEach((sel) => sel.addEventListener('change', async () => {
    await api('/api/admin/users/' + sel.dataset.id + '/assign', { method: 'POST',
      body: JSON.stringify({ clientId: sel.value || null }) });
    toast('user reassigned');
  }));
  $$('#users [data-deact]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/admin/users/' + b.dataset.deact + '/deactivate', { method: 'POST', body: '{}' });
      toast('user deactivated'); load(); } catch (e) { toast(e.message, true); }
  }));
  $$('#users [data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('/api/admin/users/' + b.dataset.reset + '/reset', { method: 'POST', body: '{}' });
    toast('access reset — invite link emailed'); load();
  }));
  $$('#users [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const rows = await api('/api/admin/users/' + b.dataset.act + '/activity');
    $('#act-hint').style.display = 'none';
    $('#activity tbody').innerHTML =
      '<tr><th>When</th><th>Action</th><th>Entity</th><th>IP</th></tr>' +
      rows.map((r) => '<tr><td>' + fmtWhen(r.at) + '</td><td>' + esc(r.action) + '</td>' +
        '<td>' + esc(r.entityType) + '</td><td>' + esc(r.ip || '—') + '</td></tr>').join('')
      || '<tr><td class="sub">no activity</td></tr>';
  }));
}
$('#iv-go').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/users/invite', { method: 'POST', body: JSON.stringify({
      email: $('#iv-email').value, firstName: $('#iv-first').value, lastName: $('#iv-last').value,
      role: $('#iv-role').value, clientId: $('#iv-client').value || null }) });
    closeModal('m-invite');
    toast('invite sent — link: /accept-invite?token=' + r.inviteToken);
    load();
  } catch (e) { toast(e.message, true); }
});
load();`;

// ---------------------------------------------------------------------------

export const CLIENT_ADMIN_BODY = `
<div id="onboard-banner"></div>
<div class="grid2">
  <div class="panel"><h2>Organization profile</h2>
    <div class="filters" style="flex-direction:column;align-items:stretch" id="profile">
      <label>Client name<input data-f="name"></label>
      <label>Tax ID (TIN)<input data-f="taxId"></label>
      <label>Group NPI<input data-f="npiGroup"></label>
      <label>Specialty<input data-f="specialty"></label>
      <label>State<input data-f="state" maxlength="2"></label>
      <label>Timezone<input data-f="timezone"></label>
      <label>Nightly run time<input data-f="nightlyRunTime" type="time"></label>
      <label>Alert threshold $<input data-f="alertThreshold" type="number"></label>
      <label>Review threshold $<input data-f="reviewThreshold" type="number"></label>
    </div>
    <button class="btn primary" id="save-profile">Save profile</button>
    <div id="sub-panel" style="margin-top:14px"></div>
  </div>
  <div class="panel"><h2>Payer configuration</h2>
    <table class="data" id="payers"><tbody></tbody></table>
    <h2 style="margin-top:14px">Contracts &amp; fee schedules</h2>
    <table class="data" id="contracts"><tbody></tbody></table>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      <input type="file" id="doc-file">
      <select id="doc-type"><option>contract</option><option>fee_schedule</option><option>payer_policy</option></select>
      <button class="btn small" id="doc-up">Upload document</button>
    </div>
    <ul class="feed" id="docs"></ul>
  </div>
</div>
<div class="grid2">
  <div class="panel"><h2>Integration settings</h2>
    <div class="filters" style="flex-direction:column;align-items:stretch">
      <label>SFTP host<input id="sftp-host"></label>
      <label>SFTP port<input id="sftp-port" type="number" value="22"></label>
      <label>SFTP username<input id="sftp-user"></label>
      <label>SFTP password<input id="sftp-pass" type="password" placeholder="(unchanged)"></label>
      <label>Drop path<input id="sftp-path" placeholder="/inbound/835"></label>
      <label>Clearinghouse<input id="ch-name" placeholder="e.g. Availity"></label>
      <label>PM / EHR system<input id="pm-name" placeholder="e.g. athenahealth"></label>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn primary" id="int-save">Save</button>
      <button class="btn" id="int-test">Test connection</button>
      <span class="sub" id="int-status"></span>
    </div>
    <h2 style="margin-top:14px">Manual upload zone</h2>
    <div class="sub" style="margin-bottom:6px">835, 837, or CSV remittance export — parsed
      for preview first, nothing is written until you commit.</div>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="file" id="edi-file" accept=".835,.837,.era,.csv">
      <button class="btn" id="edi-preview">Preview</button>
      <button class="btn primary" id="edi-commit" style="display:none">Commit &amp; run detection</button>
    </div>
    <div id="edi-summary" style="margin-top:10px"></div>
    <h2 style="margin-top:14px">API keys</h2>
    <div class="sub" style="margin-bottom:6px">For PM/EHR direct connections —
      see the <a href="/api/v1/docs" target="_blank">API reference</a>.</div>
    <table class="data" id="apikeys"><tbody></tbody></table>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      <input id="key-name" placeholder="key name (e.g. athenahealth prod)">
      <button class="btn small" id="key-create">Create key</button>
    </div>
    <div id="key-new" class="sub" style="margin-top:6px"></div>
    <h2 style="margin-top:14px">Inbound SFTP drop</h2>
    <div class="sub" style="margin-bottom:6px">Credentials for the client's PM/clearinghouse
      to push 835/837/CSV files directly. Files land in the same folder the manual upload
      zone and nightly sweep use.</div>
    <div id="sftp-cred-status"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn small" id="sftp-cred-generate">Generate new credentials</button>
      <button class="btn small danger" id="sftp-cred-revoke" style="display:none">Revoke</button>
    </div>
    <div id="sftp-cred-new" class="sub" style="margin-top:6px"></div>
    <h2 style="margin-top:14px">Outbound deliveries</h2>
    <table class="data" id="deliveries"><tbody></tbody></table>
  </div>
  <div class="panel"><h2>Billing &amp; subscription</h2><div id="billing"></div></div>
</div>
<div class="panel" style="margin-top:14px"><h2>Onboarding checklist</h2>
  <ul class="checklist" id="onboarding"></ul></div>
<div class="panel" style="margin-top:14px"><h2>Team</h2>
  <table class="data" id="team"><tbody></tbody></table></div>`;

export const CLIENT_ADMIN_JS = `
const clientId = location.pathname.split('/').pop();
let detail = null;

async function load() {
  detail = await api('/api/admin/clients/' + clientId);
  const c = detail.client;
  $$('#profile [data-f]').forEach((el) => { el.value = c[el.dataset.f] ?? ''; });

  $('#sub-panel').innerHTML = '<h2>Subscription &amp; features</h2>' +
    '<div class="filters"><label>Status<select id="sub-status">' +
    ['trial','active','suspended','cancelled'].map((s) =>
      '<option' + (c.subscription === s ? ' selected' : '') + '>' + s + '</option>').join('') +
    '</select></label></div><div id="features">' +
    Object.entries(c.features).map(([f, on]) =>
      '<label style="margin-right:14px"><input type="checkbox" class="feat" data-f="' + f + '"' +
      (on ? ' checked' : '') + '> ' + f + '</label>').join('') + '</div>' +
    '<div class="sub" style="margin-top:6px">BAA: ' +
    (c.baaAcknowledgedAt ? 'acknowledged ' + fmtWhen(c.baaAcknowledgedAt) : 'NOT acknowledged') + '</div>';
  $('#sub-status').addEventListener('change', async (e) => {
    try { await api('/api/admin/clients/' + clientId + '/subscription',
      { method: 'POST', body: JSON.stringify({ status: e.target.value }) });
      toast('subscription updated'); } catch (err) { toast(err.message, true); }
  });
  $$('.feat').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api('/api/admin/clients/' + clientId + '/features',
      { method: 'POST', body: JSON.stringify({ feature: cb.dataset.f, enabled: cb.checked }) });
      toast('feature ' + cb.dataset.f + (cb.checked ? ' enabled' : ' disabled'));
    } catch (err) { toast(err.message, true); cb.checked = !cb.checked; }
  }));

  $('#payers tbody').innerHTML =
    '<tr><th>Payer</th><th class="num">Filing days</th><th class="num">Appeal days</th>' +
    '<th>Portal</th><th>Autopilot</th><th class="num">Review $</th><th></th></tr>' +
    detail.payers.map((p, i) => '<tr>' +
      '<td>' + esc(p.name) + (p.editable ? '' : ' <span class="sub">(shared)</span>') + '</td>' +
      '<td class="num"><input style="width:56px" data-p="' + i + '" class="p-filing" value="' + (p.timelyFilingDays ?? '') + '"' + (p.editable ? '' : ' disabled') + '></td>' +
      '<td class="num"><input style="width:56px" data-p="' + i + '" class="p-appeal" value="' + (p.appealDeadlineDays ?? '') + '"' + (p.editable ? '' : ' disabled') + '></td>' +
      '<td><input style="width:130px" data-p="' + i + '" class="p-portal" value="' + esc(p.portalUrl ?? '') + '"' + (p.editable ? '' : ' disabled') + '></td>' +
      '<td><input type="checkbox" data-p="' + i + '" class="p-auto"' + (p.autopilot ? ' checked' : '') + '></td>' +
      '<td class="num"><input style="width:70px" data-p="' + i + '" class="p-review" value="' + (p.reviewThreshold ?? '') + '"></td>' +
      '<td><button class="btn small p-save" data-p="' + i + '">Save</button></td></tr>').join('');
  $$('.p-save').forEach((b) => b.addEventListener('click', async () => {
    const i = b.dataset.p, p = detail.payers[i];
    try {
      await api('/api/admin/clients/' + clientId + '/payer-config', { method: 'POST',
        body: JSON.stringify({
          payerId: p.payerId,
          autopilot: $('.p-auto[data-p="' + i + '"]').checked,
          reviewThreshold: $('.p-review[data-p="' + i + '"]').value || null,
          ...(p.editable ? {
            timelyFilingDays: Number($('.p-filing[data-p="' + i + '"]').value) || null,
            appealDeadlineDays: Number($('.p-appeal[data-p="' + i + '"]').value) || null,
            portalUrl: $('.p-portal[data-p="' + i + '"]').value || null,
          } : {}) }) });
      toast('payer configuration saved');
    } catch (e) { toast(e.message, true); }
  }));

  $('#contracts tbody').innerHTML =
    '<tr><th>Payer</th><th>Effective</th><th>Type</th><th class="num">Lines</th></tr>' +
    detail.contracts.map((x) => '<tr><td>' + esc(x.payerName) + '</td>' +
      '<td>' + fmtDate(x.effectiveDate) + '</td><td>' + esc(x.feeScheduleType) + '</td>' +
      '<td class="num">' + x.lines + '</td></tr>').join('')
    || '<tr><td class="sub" colspan="4">no contracts</td></tr>';
  $('#docs').innerHTML = detail.documents.map((d) =>
    '<li>' + esc(d.fileName) + ' <span class="meta">' + esc(d.type) + ' · ' + fmtWhen(d.uploadedAt) + '</span></li>').join('');

  const it = detail.integration || {};
  $('#sftp-host').value = it.sftpHost || ''; $('#sftp-port').value = it.sftpPort || 22;
  $('#sftp-user').value = it.sftpUsername || ''; $('#sftp-path').value = it.sftpPath || '';
  $('#ch-name').value = it.clearinghouseName || ''; $('#pm-name').value = it.pmSystem || '';
  $('#int-status').textContent = it.lastTestedAt
    ? 'last tested ' + fmtWhen(it.lastTestedAt) : 'never tested';

  if (it.sftpInboundEnabled && it.sftpInboundUsername) {
    $('#sftp-cred-status').innerHTML =
      '<span class="badge won">active</span> username <code>' + esc(it.sftpInboundUsername) +
      '</code> · issued ' + fmtWhen(it.sftpInboundCreatedAt);
    $('#sftp-cred-revoke').style.display = '';
  } else {
    $('#sftp-cred-status').innerHTML = '<span class="badge lost">none configured</span>';
    $('#sftp-cred-revoke').style.display = 'none';
  }

  const steps = (await api('/api/admin/clients/' + clientId + '/onboarding')).steps;
  const done = steps.filter((s) => s.completed).length;
  $('#onboarding').innerHTML = steps.map((s) =>
    '<li class="' + (s.completed ? 'ok' : 'missing') + '">Step ' + s.stepNumber + ': ' + esc(s.label) +
    (s.completed ? ' <span class="meta">' + fmtWhen(s.completedAt) + '</span>'
      : ' <button class="btn small ob-done" data-k="' + s.key + '">mark complete</button>') + '</li>').join('');
  $('#onboard-banner').innerHTML = done < steps.length
    ? '<div class="panel" style="border-left:4px solid var(--amber);margin-bottom:14px">' +
      '<b>Onboarding: ' + done + '/' + steps.length + ' complete</b>' +
      '<span class="sub"> — remaining: ' +
      steps.filter((s) => !s.completed).map((s) => esc(s.label)).join('; ') + '</span></div>' : '';
  $$('.ob-done').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/admin/clients/' + clientId + '/onboarding/' + b.dataset.k + '/complete',
      { method: 'POST', body: '{}' });
    toast('step completed'); load();
  }));

  $('#team tbody').innerHTML =
    '<tr><th>User</th><th>Role</th><th>Scope</th><th>Status</th><th>MFA</th><th>Last login</th></tr>' +
    detail.users.map((u) => '<tr><td>' + esc(u.name || u.email) + '</td>' +
      '<td>' + esc(u.role.replaceAll('_',' ')) + '</td><td>' + esc(u.scope) + '</td>' +
      '<td>' + stBadge(u.status) + '</td><td>' + (u.mfaEnabled ? '✓' : '—') + '</td>' +
      '<td>' + (u.lastLogin ? fmtWhen(u.lastLogin) : 'never') + '</td></tr>').join('');

  loadBilling();
}
async function loadBilling() {
  const b = await api('/api/admin/clients/' + clientId + '/billing');
  $('#billing').innerHTML =
    '<div class="kv">' +
    '<div><dt>Plan</dt><dd><b>' + esc(b.plan) + '</b> ($' + b.pricing.base + '/mo + $' + b.pricing.perCase + '/case)</dd></div>' +
    '<div><dt>Status</dt><dd>' + stBadge(b.subscriptionStatus) + '</dd></div>' +
    '<div><dt>Claims this period</dt><dd>' + b.usageThisPeriod.claimsProcessed + '</dd></div>' +
    '<div><dt>Cases this period</dt><dd>' + b.usageThisPeriod.casesCreated + '</dd></div>' +
    '<div><dt>Recovered this period</dt><dd>' + usd(b.usageThisPeriod.amountRecovered) + '</dd></div></div>' +
    '<div class="filters" style="margin-top:8px"><label>Change plan<select id="plan-sel">' +
    b.availablePlans.map((p) => '<option' + (p.name === b.plan ? ' selected' : '') + '>' + p.name + '</option>').join('') +
    '</select></label>' +
    '<label>Generate invoice<input id="inv-month" placeholder="YYYY-MM" style="width:90px"></label>' +
    '<button class="btn small" id="inv-go">Generate</button></div>' +
    '<table class="data"><tbody><tr><th>Period</th><th>Plan</th><th class="num">Cases</th>' +
    '<th class="num">Recovered</th><th class="num">Due</th><th>Status</th></tr>' +
    b.invoices.map((i) => '<tr><td>' + i.periodStart + '</td><td>' + esc(i.plan) + '</td>' +
      '<td class="num">' + i.casesCreated + '</td><td class="num">' + usd(i.amountRecovered) + '</td>' +
      '<td class="num">' + usd(i.amountDue) + '</td><td>' + stBadge(i.status) + '</td></tr>').join('') +
    '</tbody></table>';
  $('#plan-sel').addEventListener('change', async (e) => {
    try { await api('/api/admin/plan', { method: 'POST', body: JSON.stringify({ tier: e.target.value }) });
      toast('plan changed'); loadBilling(); } catch (err) { toast(err.message, true); }
  });
  $('#inv-go').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/clients/' + clientId + '/billing/invoice',
        { method: 'POST', body: JSON.stringify({ month: $('#inv-month').value }) });
      toast('invoice generated: ' + usd(r.amountDue)); loadBilling();
    } catch (e) { toast(e.message, true); }
  });
}
$('#save-profile').addEventListener('click', async () => {
  const body = {};
  $$('#profile [data-f]').forEach((el) => { body[el.dataset.f] = el.value; });
  try {
    await api('/api/admin/clients/' + clientId + '/settings',
      { method: 'POST', body: JSON.stringify(body) });
    toast('profile saved'); load();
  } catch (e) { toast(e.message, true); }
});
$('#int-save').addEventListener('click', async () => {
  try {
    await api('/api/admin/clients/' + clientId + '/integration', { method: 'POST',
      body: JSON.stringify({
        sftpHost: $('#sftp-host').value || undefined,
        sftpPort: Number($('#sftp-port').value) || undefined,
        sftpUsername: $('#sftp-user').value || undefined,
        sftpPassword: $('#sftp-pass').value || undefined,
        sftpPath: $('#sftp-path').value || undefined,
        clearinghouseName: $('#ch-name').value || undefined,
        pmSystem: $('#pm-name').value || undefined }) });
    toast('integration settings saved (credentials encrypted)'); $('#sftp-pass').value = '';
  } catch (e) { toast(e.message, true); }
});
$('#int-test').addEventListener('click', async () => {
  try { await api('/api/admin/clients/' + clientId + '/integration/test', { method: 'POST', body: '{}' });
    toast('connection test passed'); load(); } catch (e) { toast(e.message, true); }
});
$('#doc-up').addEventListener('click', async () => {
  const f = $('#doc-file').files[0];
  if (!f) return toast('choose a file', true);
  const res = await fetch('/api/admin/clients/' + clientId + '/documents?filename=' +
    encodeURIComponent(f.name) + '&type=' + $('#doc-type').value, { method: 'POST', body: f });
  if (res.ok) { toast('document uploaded'); load(); } else toast((await res.json()).error, true);
});
$('#edi-preview').addEventListener('click', async () => {
  const f = $('#edi-file').files[0];
  if (!f) return toast('choose a file', true);
  const res = await fetch('/api/admin/clients/' + clientId + '/ingest/preview?filename=' +
    encodeURIComponent(f.name), { method: 'POST', body: f });
  const p = await res.json();
  if (!res.ok) return toast(p.error, true);
  const s = p.summary;
  $('#edi-summary').innerHTML =
    '<div class="' + (p.ok ? '' : 'deadline-red') + '"><b>' + p.kind.toUpperCase() + '</b> — ' +
    s.claims + ' claim(s), ' + s.lines + ' line(s)' +
    (s.transactions ? ' in ' + s.transactions + ' transaction(s)' : '') +
    (s.payers && s.payers.length ? ' · payer: ' + s.payers.map(esc).join(', ') : '') +
    ' · billed ' + usd(s.totalBilled) + ' · paid ' + usd(s.totalPaid) + '</div>' +
    (p.errors.length ? '<div class="deadline-red">' + p.errors.map(esc).join('<br>') + '</div>' : '') +
    (s.sample.length ? '<table class="data"><tbody><tr>' +
      Object.keys(s.sample[0]).map((k) => '<th>' + esc(k) + '</th>').join('') + '</tr>' +
      s.sample.map((row) => '<tr>' + Object.values(row).map((v) =>
        '<td>' + esc(v == null ? '—' : String(v)) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>' : '');
  $('#edi-commit').style.display = p.ok ? '' : 'none';
});
$('#edi-commit').addEventListener('click', async () => {
  const f = $('#edi-file').files[0];
  if (!f) return;
  $('#edi-commit').disabled = true;
  const res = await fetch('/api/admin/clients/' + clientId + '/ingest?detect=1&filename=' +
    encodeURIComponent(f.name), { method: 'POST', body: f });
  const body = await res.json();
  $('#edi-commit').disabled = false;
  if (res.ok) {
    toast(body.recordsProcessed + ' record(s) ingested' +
      (body.detection ? ' · detection: ' + body.detection.casesCreated + ' new case(s), ' +
        usd(body.detection.totalRecoveryOpportunity) + ' identified' : ''));
    $('#edi-commit').style.display = 'none'; $('#edi-summary').innerHTML = '';
    load();
  } else toast(body.error, true);
});
async function loadKeys() {
  const { keys } = await api('/api/admin/clients/' + clientId + '/api-keys');
  $('#apikeys tbody').innerHTML =
    '<tr><th>Name</th><th>Key</th><th>Scopes</th><th class="num">Limit/min</th>' +
    '<th class="num">Calls (30d)</th><th>Last used</th><th></th></tr>' +
    keys.map((k) => '<tr' + (k.revoked ? ' style="opacity:.5"' : '') + '>' +
      '<td>' + esc(k.name) + '</td><td><code>' + esc(k.keyPrefix) + '</code>' +
      (k.revoked ? ' <span class="badge lost">revoked</span>' : '') + '</td>' +
      '<td>' + k.scopes.join(', ') + '</td><td class="num">' + k.rateLimitPerMinute + '</td>' +
      '<td class="num">' + k.calls30d + '</td>' +
      '<td>' + (k.lastUsedAt ? fmtWhen(k.lastUsedAt) : 'never') + '</td>' +
      '<td>' + (k.revoked ? '' : '<button class="btn small danger" data-rk="' + k.apiKeyId + '">Revoke</button>') +
      '</td></tr>').join('') || '<tr><td class="sub">no API keys yet</td></tr>';
  $$('#apikeys [data-rk]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/admin/api-keys/' + b.dataset.rk + '/revoke', { method: 'POST', body: '{}' });
    toast('key revoked'); loadKeys();
  }));
  const { deliveries } = await api('/api/admin/clients/' + clientId + '/deliveries');
  $('#deliveries tbody').innerHTML =
    '<tr><th>When</th><th>Connector</th><th>Kind</th><th>Status</th></tr>' +
    deliveries.slice(0, 10).map((d) => '<tr><td>' + fmtWhen(d.created_at) + '</td>' +
      '<td>' + esc(d.connector) + '</td><td>' + esc(d.kind.replaceAll('_',' ')) + '</td>' +
      '<td>' + stBadge(d.status) + '</td></tr>').join('')
    || '<tr><td class="sub" colspan="4">no outbound dispatches yet</td></tr>';
}
$('#key-create').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/clients/' + clientId + '/api-keys',
      { method: 'POST', body: JSON.stringify({ name: $('#key-name').value }) });
    $('#key-new').innerHTML = '<b>Copy this key now — it is shown once:</b> ' +
      '<code style="user-select:all">' + esc(r.apiKey) + '</code>';
    $('#key-name').value = ''; loadKeys();
  } catch (e) { toast(e.message, true); }
});
$('#sftp-cred-generate').addEventListener('click', async () => {
  if (detail.integration && detail.integration.sftpInboundEnabled) {
    if (!confirm('This replaces the existing credentials — the old ones stop working immediately. Continue?')) return;
  }
  try {
    const r = await api('/api/admin/clients/' + clientId + '/sftp-credentials', { method: 'POST', body: '{}' });
    $('#sftp-cred-new').innerHTML =
      '<b>Copy these now — the password is shown once:</b><br>' +
      'Username: <code style="user-select:all">' + esc(r.username) + '</code><br>' +
      'Password: <code style="user-select:all">' + esc(r.password) + '</code>';
    load();
  } catch (e) { toast(e.message, true); }
});
$('#sftp-cred-revoke').addEventListener('click', async () => {
  if (!confirm('Revoke SFTP access for this client? Their PM/clearinghouse will no longer be able to connect.')) return;
  try {
    await api('/api/admin/clients/' + clientId + '/sftp-credentials/revoke', { method: 'POST', body: '{}' });
    $('#sftp-cred-new').innerHTML = '';
    toast('SFTP credentials revoked'); load();
  } catch (e) { toast(e.message, true); }
});
load(); loadKeys();`;

// ---------------------------------------------------------------------------

export const COMPLIANCE_BODY = `
<div class="grid2">
  <div class="panel"><h2>Full audit trail</h2>
    <div class="filters" id="af">
      <label>Action<select name="action"><option value="">all</option></select></label>
      <label>Entity<select name="entityType"><option value="">all</option></select></label>
      <label>From<input type="date" name="from"></label>
      <label>To<input type="date" name="to"></label>
      <button class="btn small" id="audit-csv">Export CSV</button>
      <button class="btn small" onclick="window.print()">PDF</button>
    </div>
    <table class="data" id="audit"><tbody></tbody></table>
  </div>
  <div class="panel"><h2>PHI access log (HIPAA)</h2>
    <div class="filters" id="pf">
      <label>From<input type="date" name="from"></label>
      <label>To<input type="date" name="to"></label>
      <button class="btn small" id="phi-csv">Export CSV</button>
    </div>
    <table class="data" id="phi"><tbody></tbody></table>
  </div>
</div>
<div class="grid2">
  <div class="panel"><h2>System job log</h2>
    <div class="filters" id="jf">
      <label>Status<select name="status"><option value="">all</option>
        <option>completed</option><option>failed</option><option>running</option><option>queued</option></select></label>
    </div>
    <table class="data" id="jobs"><tbody></tbody></table>
  </div>
  <div class="panel"><h2>Data export requests</h2>
    <div class="filters">
      <label>Request export<select id="ex-type"><option value="cases">cases</option>
        <option value="audit_trail">audit trail</option><option value="phi_access">PHI access</option></select></label>
      <button class="btn small primary" id="ex-go">Request</button>
    </div>
    <table class="data" id="exports"><tbody></tbody></table>
  </div>
</div>`;

export const COMPLIANCE_JS = `
let auditRows = [], phiRows = [];
async function loadAudit() {
  const p = new URLSearchParams();
  $$('#af [name]').forEach((el) => { if (el.value) p.set(el.name, el.value); });
  auditRows = (await api('/api/compliance/audit?' + p)).rows;
  $('#audit tbody').innerHTML =
    '<tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>IP</th></tr>' +
    auditRows.slice(0, 100).map((r) => '<tr><td>' + fmtWhen(r.at) + '</td>' +
      '<td>' + esc(r.user) + '</td><td>' + esc(r.action) + '</td>' +
      '<td>' + esc(r.entityType) + '</td><td>' + esc(r.ip || '—') + '</td></tr>').join('');
}
async function loadPhi() {
  const p = new URLSearchParams();
  $$('#pf [name]').forEach((el) => { if (el.value) p.set(el.name, el.value); });
  phiRows = (await api('/api/compliance/phi-access?' + p)).rows;
  $('#phi tbody').innerHTML =
    '<tr><th>When</th><th>User</th><th>Patient</th><th>MRN</th><th>Context</th></tr>' +
    phiRows.slice(0, 100).map((r) => '<tr><td>' + fmtWhen(r.at) + '</td>' +
      '<td>' + esc(r.user) + '</td><td>' + esc(r.patientName) + '</td>' +
      '<td>' + esc(r.mrn || '—') + '</td><td>' + esc(r.context || '—') + '</td></tr>').join('')
    || '<tr><td class="sub" colspan="5">no PHI access recorded</td></tr>';
}
async function loadJobs() {
  const p = new URLSearchParams();
  $$('#jf [name]').forEach((el) => { if (el.value) p.set(el.name, el.value); });
  const rows = (await api('/api/compliance/jobs?' + p)).rows;
  $('#jobs tbody').innerHTML =
    '<tr><th>Job</th><th>Status</th><th>Started</th><th class="num">Records</th><th class="num">Errors</th><th></th></tr>' +
    rows.slice(0, 50).map((r) => '<tr><td>' + esc(r.jobType.replaceAll('_',' ')) +
      '<div class="sub">' + esc(r.clientName || 'tenant-wide') + '</div></td>' +
      '<td>' + stBadge(r.status) + (r.status === 'failed' && r.detail
        ? '<div class="sub" style="max-width:240px">' + esc(r.detail.slice(0, 150)) + '</div>' : '') + '</td>' +
      '<td>' + fmtWhen(r.startedAt) + '</td><td class="num">' + (r.recordsProcessed ?? '—') + '</td>' +
      '<td class="num">' + (r.errorsCount ?? 0) + '</td>' +
      '<td>' + (r.status === 'failed' && r.rerunnable
        ? '<button class="btn small" data-rerun="' + r.jobId + '">Re-run</button>' : '') + '</td></tr>').join('');
  $$('#jobs [data-rerun]').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/compliance/jobs/' + b.dataset.rerun + '/rerun',
      { method: 'POST', body: '{}' });
      toast('job re-run started'); loadJobs();
    } catch (e) { toast(e.message, true); }
  }));
}
async function loadExports() {
  const rows = (await api('/api/exports')).rows;
  $('#exports tbody').innerHTML =
    '<tr><th>Type</th><th>Requested by</th><th>Status</th><th>When</th><th></th></tr>' +
    rows.map((r) => '<tr><td>' + esc(r.exportType.replaceAll('_',' ')) + '</td>' +
      '<td>' + esc(r.requestedBy) + '</td><td>' + stBadge(r.status) + '</td>' +
      '<td>' + fmtWhen(r.createdAt) + '</td><td>' +
      (r.status === 'pending' ? '<button class="btn small" data-appr="' + r.exportId + '">Approve</button> ' +
        '<button class="btn small danger" data-deny="' + r.exportId + '">Deny</button>' : '') +
      (['approved','downloaded'].includes(r.status)
        ? '<a class="btn small" href="/api/exports/' + r.exportId + '/download">Download</a>' : '') +
      '</td></tr>').join('') || '<tr><td class="sub">no export requests</td></tr>';
  $$('#exports [data-appr]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/exports/' + b.dataset.appr + '/approve', { method: 'POST', body: '{}' }); loadExports();
  }));
  $$('#exports [data-deny]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/exports/' + b.dataset.deny + '/deny', { method: 'POST', body: '{}' }); loadExports();
  }));
}
$('#ex-go').addEventListener('click', async () => {
  const r = await api('/api/exports', { method: 'POST',
    body: JSON.stringify({ exportType: $('#ex-type').value, params: {} }) });
  toast('export ' + r.status); loadExports();
});
$('#audit-csv').addEventListener('click', () => downloadCsv(auditRows.map((r) => ({
  when: r.at, user: r.user, action: r.action, entity_type: r.entityType,
  entity_id: r.entityId, ip: r.ip })), 'audit-trail.csv'));
$('#phi-csv').addEventListener('click', () => downloadCsv(phiRows.map((r) => ({
  when: r.at, user: r.user, patient: r.patientName, mrn: r.mrn, context: r.context })), 'phi-access.csv'));
(async () => {
  const f = await api('/api/compliance/audit-filters');
  $('#af [name=action]').innerHTML += f.actions.map((a) => '<option>' + a + '</option>').join('');
  $('#af [name=entityType]').innerHTML += f.entityTypes.map((a) => '<option>' + a + '</option>').join('');
  loadAudit(); loadPhi(); loadJobs(); loadExports();
})();
$$('#af [name]').forEach((el) => el.addEventListener('change', loadAudit));
$$('#pf [name]').forEach((el) => el.addEventListener('change', loadPhi));
$$('#jf [name]').forEach((el) => el.addEventListener('change', loadJobs));`;
