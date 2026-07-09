// ============================================================================
// Page templates. Each page is a server-rendered shell whose script fetches
// the JSON APIs and renders live data — filters, sorts, and actions all hit
// real endpoints.
// ============================================================================

export const DASHBOARD_BODY = `
<div id="onboarding-banner"></div>
<div style="display:flex;gap:8px;margin-bottom:14px">
  <a class="btn primary" href="/builder">+ New Case</a>
  <a class="btn" href="/queue">View Queue</a>
  <button class="btn" id="btn-upload" onclick="location.href='/queue'">Upload Document</button>
  <button class="btn" id="btn-detect">Run Detection</button>
</div>
<div class="cards">
  <div class="card"><h3>Open recovery opportunities</h3>
    <div class="big" id="k-open">—</div><div class="sub" id="k-open-n"></div></div>
  <div class="card"><h3>Due this week</h3>
    <div class="big" id="k-week">—</div><div class="sub" id="k-week-n"></div></div>
  <div class="card alarm"><h3>Due today / overdue</h3>
    <div class="big" id="k-today">—</div><div class="sub" id="k-today-n"></div></div>
</div>
<div class="grid3">
  <div class="panel"><h2>Recovery trend — last 90 days</h2><div id="trend"></div></div>
  <div class="panel"><h2>Recent activity</h2><ul class="feed" id="feed"></ul></div>
</div>
<div class="grid2">
  <div class="panel"><h2>Top 5 payers by recovery opportunity</h2><div id="payers"></div></div>
  <div class="panel"><h2>Top 5 denial categories this month</h2><div id="cats"></div></div>
</div>`;

export const DASHBOARD_JS = `
(async () => {
  const d = await api('/api/dashboard');
  $('#k-open').textContent = usd(d.openTotal.amount);
  $('#k-open-n').textContent = d.openTotal.count + ' open cases';
  $('#k-week').textContent = usd(d.dueThisWeek.amount);
  $('#k-week-n').textContent = d.dueThisWeek.count + ' cases due within 7 days';
  $('#k-today').textContent = usd(d.dueToday.amount);
  $('#k-today-n').textContent = d.dueToday.count + ' cases due today or overdue';
  hbarChart($('#payers'), d.topPayers.map((p) => ({ label: p.label, value: p.amount })));
  hbarChart($('#cats'), d.topCategories.map((c) => ({ label: c.label.replaceAll('_',' '), value: c.amount })), { alt: true });
  lineChart($('#trend'), d.trend.weeks, [
    { name: 'identified', color: '#1f4e8c', values: d.trend.identified },
    { name: 'submitted', color: '#b9770e', values: d.trend.submitted },
    { name: 'recovered', color: '#1e8449', values: d.trend.recovered },
  ]);
  $('#feed').innerHTML = d.activity.map((a) =>
    '<li><a href="/case/' + a.caseId + '">' + esc(a.patientName) + '</a> — ' +
    esc(a.actionType.replaceAll('_',' ')) +
    '<div class="meta">' + fmtWhen(a.date) + ' · ' + esc(a.by) +
    (a.notes ? ' — ' + esc(String(a.notes).slice(0, 90)) : '') + '</div></li>'
  ).join('') || '<li class="sub">no activity yet</li>';

  // onboarding checklist banner — shown until every step is complete
  try {
    const me = await api('/api/whoami');
    if (me.clientId) {
      const { steps } = await api('/api/admin/clients/' + me.clientId + '/onboarding');
      const done = steps.filter((s) => s.completed).length;
      if (done < steps.length) {
        $('#onboarding-banner').innerHTML =
          '<div class="panel" style="border-left:4px solid var(--amber);margin-bottom:14px">' +
          '<b>Getting started: ' + done + '/' + steps.length + ' onboarding steps complete</b>' +
          '<ul class="checklist" style="margin:6px 0 0">' +
          steps.map((s) => '<li class="' + (s.completed ? 'ok' : 'missing') + '">' +
            'Step ' + s.stepNumber + ': ' + esc(s.label) + '</li>').join('') + '</ul></div>';
      }
    }
  } catch { /* onboarding not visible for this user */ }
})();
$('#btn-detect').addEventListener('click', async () => {
  $('#btn-detect').disabled = true;
  try {
    const r = await api('/api/run-detection', { method: 'POST', body: '{}' });
    toast('Detection complete: ' + r.summary.casesCreated + ' created, ' +
      r.summary.casesUpdated + ' updated, ' + usd(r.summary.totalRecoveryOpportunity) + ' identified');
    setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(e.message, true); }
  $('#btn-detect').disabled = false;
});`;

// ---------------------------------------------------------------------------

export const QUEUE_BODY = `
<div class="filters" id="filters">
  <label>Priority<select name="priority"><option value="">all</option></select></label>
  <label>Payer<select name="payerId"><option value="">all</option></select></label>
  <label>Category<select name="category"><option value="">all</option></select></label>
  <label>Status<select name="status"><option value="">open (default)</option><option value="all">all</option></select></label>
  <label>Assigned<select name="assignedTo"><option value="">all</option><option value="unassigned">unassigned</option></select></label>
  <label>DOS from<input type="date" name="dosFrom"></label>
  <label>DOS to<input type="date" name="dosTo"></label>
  <label>Deadline from<input type="date" name="deadlineFrom"></label>
  <label>Deadline to<input type="date" name="deadlineTo"></label>
  <label>Min $<input type="number" name="amountMin" style="width:84px"></label>
  <label>Max $<input type="number" name="amountMax" style="width:84px"></label>
  <button class="btn" id="btn-clear">Clear</button>
  <button class="btn" id="btn-csv">Export CSV</button>
</div>
<div class="bulkbar" id="bulkbar">
  <span id="bulk-n"></span>
  <select id="bulk-user"></select><button class="btn small" id="bulk-assign">Assign</button>
  <select id="bulk-status"></select><button class="btn small" id="bulk-set-status">Set status</button>
</div>
<div class="panel"><table class="data" id="tbl"><thead></thead><tbody></tbody></table></div>`;

export const QUEUE_JS = `
const COLS = [
  ['sel',''], ['priority','Priority'], ['case_id','Case'], ['patient','Patient'],
  ['payer','Payer'], ['dos','DOS'], ['procedure','Proc'], ['category','Category'],
  ['amount','Recovery $'], ['deadline','Deadline'], ['status','Status'],
  ['assigned','Assigned To'], ['days_open','Days Open'], ['go','']];
let rows = [], sort = 'priority', dir = 'asc', lookups = null;
const selected = new Set();

function filterParams() {
  const p = new URLSearchParams();
  $$('#filters [name]').forEach((el) => { if (el.value) p.set(el.name, el.value); });
  p.set('sort', sort); p.set('dir', dir);
  return p;
}
async function load() {
  rows = (await api('/api/cases?' + filterParams())).rows;
  render();
}
function render() {
  $('#tbl thead').innerHTML = '<tr>' + COLS.map(([k, label]) =>
    k === 'sel' ? '<th><input type="checkbox" id="sel-all"></th>' :
    '<th data-k="' + k + '">' + label + (sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr>';
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  $('#tbl tbody').innerHTML = rows.map((r) => '<tr>' +
    '<td><input type="checkbox" class="sel" data-id="' + r.caseId + '"' + (selected.has(r.caseId) ? ' checked' : '') + '></td>' +
    '<td>' + prBadge(r.priority) + '</td>' +
    '<td><a href="/case/' + r.caseId + '">' + r.caseId.slice(0, 8) + '</a></td>' +
    '<td>' + esc(r.patientName) + '</td><td>' + esc(r.payerName) + '</td>' +
    '<td>' + fmtDate(r.dos) + '</td><td>' + esc(r.procedureCode || '—') + '</td>' +
    '<td>' + esc((r.category || '').replaceAll('_',' ')) + '</td>' +
    '<td class="num">' + usd(r.amount) + '</td>' +
    '<td class="' + (r.deadline && r.deadline <= soon ? 'deadline-red' : '') + '">' + fmtDate(r.deadline) + '</td>' +
    '<td>' + stBadge(r.status) + '</td>' +
    '<td>' + esc(r.assignedTo || '—') + '</td><td class="num">' + r.daysOpen + '</td>' +
    '<td><a class="btn small" href="/case/' + r.caseId + '">Work</a></td></tr>').join('')
    || '<tr><td colspan="14" class="sub">no cases match</td></tr>';
  $$('#tbl thead th[data-k]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (['go'].includes(k)) return;
    if (sort === k) dir = dir === 'asc' ? 'desc' : 'asc'; else { sort = k; dir = 'asc'; }
    load();
  }));
  $('#sel-all')?.addEventListener('change', (e) => {
    selected.clear();
    if (e.target.checked) rows.forEach((r) => selected.add(r.caseId));
    render();
  });
  $$('.sel').forEach((cb) => cb.addEventListener('change', () => {
    cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id);
    syncBulk();
  }));
  syncBulk();
}
function syncBulk() {
  $('#bulkbar').classList.toggle('on', selected.size > 0);
  $('#bulk-n').textContent = selected.size + ' selected';
}
(async () => {
  lookups = await api('/api/lookups');
  const opt = (v, l) => '<option value="' + v + '">' + esc(l) + '</option>';
  $('[name=priority]').innerHTML += lookups.priorities.map((p) => opt(p, p)).join('');
  $('[name=payerId]').innerHTML += lookups.payers.map((p) => opt(p.id, p.name)).join('');
  $('[name=category]').innerHTML += lookups.categories.map((c) => opt(c, c.replaceAll('_',' '))).join('');
  $('[name=status]').innerHTML += lookups.statuses.map((s) => opt(s, s)).join('');
  $('[name=assignedTo]').innerHTML += lookups.users.map((u) => opt(u.id, u.name)).join('');
  $('#bulk-user').innerHTML = '<option value="">— unassign —</option>' + lookups.users.map((u) => opt(u.id, u.name)).join('');
  $('#bulk-status').innerHTML = lookups.statuses.map((s) => opt(s, s)).join('');
  await load();
})();
$$('#filters [name]').forEach((el) => el.addEventListener('change', load));
$('#btn-clear').addEventListener('click', () => { $$('#filters [name]').forEach((el) => el.value = ''); load(); });
$('#btn-csv').addEventListener('click', () => downloadCsv(rows.map((r) => ({
  case_id: r.caseId, priority: r.priority, patient: r.patientName, payer: r.payerName,
  dos: r.dos, procedure: r.procedureCode, category: r.category, denial_code: r.denialCode,
  recovery: r.amount, deadline: r.deadline, status: r.status, assigned_to: r.assignedTo,
  days_open: r.daysOpen })), 'case-queue.csv'));
async function bulk(action) {
  try {
    const r = await api('/api/cases/bulk', { method: 'POST',
      body: JSON.stringify({ caseIds: [...selected], ...action }) });
    toast(r.updated + ' case(s) updated'); selected.clear(); await load();
  } catch (e) { toast(e.message, true); }
}
$('#bulk-assign').addEventListener('click', () => bulk({ assignTo: $('#bulk-user').value || null }));
$('#bulk-set-status').addEventListener('click', () => bulk({ status: $('#bulk-status').value }));`;

// ---------------------------------------------------------------------------

export const CASE_BODY = `
<div class="threecol">
  <div class="panel" id="left"><h2>Case Summary</h2><div id="summary" class="kv"></div></div>
  <div class="panel" id="center"><h2>Claim Detail</h2><div id="claim"></div></div>
  <div class="panel" id="right"><h2>Appeal Packet</h2><div id="packet"></div></div>
</div>
<div class="panel" style="margin-top:14px"><h2>Case Timeline</h2>
  <ul class="timeline" id="timeline"></ul>
  <div style="display:flex;gap:8px;margin-top:10px">
    <textarea class="note" id="note" placeholder="Add a note…" style="flex:1" rows="2"></textarea>
    <button class="btn" id="btn-note">Add note</button>
    <button class="btn" id="btn-call">Log payer call</button>
  </div>
</div>
<div class="modal-back" id="m-assign"><div class="modal"><h3>Reassign case</h3>
  <div class="row">Assign to<select id="assign-user"></select></div>
  <div class="actions"><button class="btn" onclick="closeModal('m-assign')">Cancel</button>
  <button class="btn primary" id="assign-go">Assign</button></div></div></div>
<div class="modal-back" id="m-call"><div class="modal"><h3>Log payer call</h3>
  <div class="row">Outcome<select id="call-outcome">
    <option>reprocessing_initiated</option><option>additional_info_requested</option>
    <option>appeal_upheld</option><option>escalated</option><option>no_resolution</option></select></div>
  <div class="row">Notes<textarea id="call-notes" rows="3"></textarea></div>
  <div class="actions"><button class="btn" onclick="closeModal('m-call')">Cancel</button>
  <button class="btn primary" id="call-go">Log call</button></div></div></div>
<div class="modal-back" id="m-upload"><div class="modal"><h3>Upload document</h3>
  <div class="row">Type<select id="up-type">
    <option>medical_record</option><option>authorization</option><option>eob</option>
    <option>contract</option><option>fee_schedule</option><option>payer_policy</option><option>other</option></select></div>
  <div class="row">File<input type="file" id="up-file"></div>
  <div class="actions"><button class="btn" onclick="closeModal('m-upload')">Cancel</button>
  <button class="btn primary" id="up-go">Upload</button></div></div></div>`;

export const CASE_JS = `
const caseId = location.pathname.split('/').pop();
let detail = null, lookups = null;
const soonCut = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);

async function load() {
  [detail, lookups] = await Promise.all([api('/api/cases/' + caseId), api('/api/lookups')]);
  const { case: c, patient, claim, payer, packet, remitLines, timeline } = detail;

  const days = c.deadline ? Math.ceil((new Date(c.deadline) - Date.now()) / 864e5) : null;
  $('#summary').innerHTML =
    kv('Case', c.caseId.slice(0, 8)) + kv('Status', stBadge(c.status)) +
    kv('Priority', prBadge(c.priority)) + kv('Created', fmtDate(c.createdAt)) +
    kv('Type', esc(c.caseType)) + kv('Category', esc((c.category || '—').replaceAll('_',' '))) +
    kv('Denial code', esc(c.denialCode || '—')) +
    '<hr>' + kv('Patient', esc(patient.name)) + kv('DOB', fmtDate(patient.dob)) +
    kv('MRN', esc(patient.mrn)) + kv('Insurance ID', esc(patient.insuranceId || '—')) +
    '<hr>' + kv('Claim #', esc(claim.number)) + kv('DOS', fmtDate(claim.dos)) +
    kv('Billed', usd(claim.billed)) + kv('Expected', usd(c.expectedAmount)) + kv('Paid', usd(c.paidAmount)) +
    '<hr><div style="text-align:center;padding:6px 0"><div class="sub">Recovery opportunity</div>' +
    '<div class="bignum">' + usd(c.recoveryOpportunity) + '</div>' +
    '<div class="' + (days != null && days <= 14 ? 'deadline-red' : 'sub') + '">' +
    (c.deadline ? ('deadline ' + fmtDate(c.deadline) + (days != null ? ' (' + (days < 0 ? Math.abs(days) + ' days past' : days + ' days left') + ')' : '')) : 'no deadline') + '</div></div>' +
    '<hr>' + kv('Payer', esc(payer.name)) +
    kv('Portal', payer.portalUrl ? '<a href="' + esc(payer.portalUrl) + '" target="_blank">open portal ↗</a>' : '—') +
    kv('Appeal address', esc(payer.appealAddress || '—')) +
    '<hr>' + kv('Assigned to', esc(c.assignedTo || 'unassigned') +
      ' <button class="btn small" id="btn-assign">reassign</button>') +
    (c.recommendedAction ? '<hr><div class="sub" style="padding:4px 0"><b>Recommended:</b> ' + esc(c.recommendedAction) + '</div>' : '');

  $('#claim').innerHTML =
    '<div class="sub" style="margin-bottom:6px">Claim ' + esc(claim.number) +
    (claim.payerNumber ? ' · payer # ' + esc(claim.payerNumber) : '') +
    ' · submitted ' + fmtDate(claim.submissionDate) + ' · status ' + esc(claim.status) +
    (claim.authorizationNumber ? ' · <b>auth ' + esc(claim.authorizationNumber) + '</b>' : '') + '</div>' +
    '<table class="data"><thead><tr><th>#</th><th>Code</th><th>Mods</th><th class="num">Units</th>' +
    '<th class="num">Billed</th><th class="num">Expected</th><th class="num">Paid</th>' +
    '<th class="num">Variance</th><th>Denial</th></tr></thead><tbody>' +
    claim.lines.map((l) => '<tr><td>' + l.lineNumber + '</td><td>' + esc(l.procedureCode) + '</td>' +
      '<td>' + esc(l.modifiers.join(', ') || '—') + '</td><td class="num">' + l.units + '</td>' +
      '<td class="num">' + usd(l.billed) + '</td>' +
      '<td class="num">' + usd(l.expected) + (l.expectedSource === 'medicare_proxy' ? ' <span class="sub">(proxy)</span>' : '') + '</td>' +
      '<td class="num">' + usd(l.paid) + '</td>' +
      '<td class="num ' + (l.variance > 0 ? 'deadline-red' : '') + '">' + usd(l.variance) + '</td>' +
      '<td>' + (l.denialCode ? esc(l.denialCode) + '<div class="sub">' + esc(l.denialDescription || '') + '</div>' : '—') + '</td></tr>').join('') +
    '</tbody></table>' +
    '<h2 style="margin-top:16px">Remittance (835) data</h2>' +
    (remitLines.length ? '<table class="data"><thead><tr><th>Check</th><th>Date</th><th>Code</th>' +
      '<th class="num">Billed</th><th class="num">Allowed</th><th class="num">Paid</th><th>Adj</th></tr></thead><tbody>' +
      remitLines.map((x) => '<tr><td>' + esc(x.checkNumber || '—') + '</td><td>' + fmtDate(x.checkDate) + '</td>' +
        '<td>' + esc(x.procedureCode || '(claim)') + '</td><td class="num">' + usd(x.billed) + '</td>' +
        '<td class="num">' + usd(x.allowed) + '</td><td class="num">' + usd(x.paid) + '</td>' +
        '<td>' + esc(x.adjustment || '—') + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="sub">no remittance on file</div>');

  renderPacket(packet);

  $('#timeline').innerHTML = timeline.map((t) =>
    '<li><span class="when">' + fmtWhen(t.date) + '</span><span>' + esc(t.by) + '</span>' +
    '<span><b>' + esc(t.actionType.replaceAll('_',' ')) + '</b>' +
    (t.notes ? ' — ' + esc(t.notes) : '') + '</span></li>').join('');

  $('#assign-user').innerHTML = '<option value="">— unassign —</option>' +
    lookups.users.map((u) => '<option value="' + u.id + '">' + esc(u.name) + '</option>').join('');
  $('#btn-assign').addEventListener('click', () => openModal('m-assign'));
}
function kv(k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }

function renderPacket(p) {
  if (!p) { $('#packet').innerHTML = '<div class="sub">No packet generated yet — run appeal generation.</div>'; return; }
  const missing = p.missingDocumentTypes;
  const canSubmit = p.status === 'ready' && ['portal', 'clearinghouse'].includes(p.submissionMethod);
  $('#packet').innerHTML =
    '<div style="margin-bottom:8px"><span class="badge ' + (p.status === 'ready' ? 'ready' : p.status === 'draft' ? 'draft' : 'st') + '">' +
    esc(p.status) + '</span> ' + esc(p.appealType.replaceAll('_',' ')) + ' via ' + esc(p.submissionMethod || '—') +
    (p.needsReview ? '<div class="sub deadline-red" style="margin-top:4px">needs review: ' + esc(p.needsReviewReasons.join('; ')) + '</div>' : '') + '</div>' +
    '<ul class="checklist">' +
    p.documents.map((d) => '<li class="ok">' + esc(d.documentType.replaceAll('_',' ')) + ' — ' + esc(d.fileName) + '</li>').join('') +
    missing.map((m) => '<li class="missing">' + esc(m.replaceAll('_',' ')) + ' — missing</li>').join('') + '</ul>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
    '<button class="btn small" id="btn-upload2">Upload document</button>' +
    (p.submittedAt ? '' :
      '<button class="btn small primary" id="btn-submit"' + (canSubmit ? '' : ' disabled') + '>Submit electronically</button>' +
      '<button class="btn small" id="btn-mailed">Mark mailed/faxed</button>') +
    '</div>' +
    (p.submittedAt ? '<div class="sub">submitted ' + fmtWhen(p.submittedAt) +
      (p.payerReference ? ' · payer ref ' + esc(p.payerReference) : '') + '</div>' : '') +
    '<h2 style="margin-top:12px">Appeal letter</h2><div class="letter" id="letter">loading…</div>' +
    '<h2 style="margin-top:12px">Submission history</h2>' +
    '<ul class="feed">' + p.history.map((h) =>
      '<li>' + esc(h.appealType.replaceAll('_',' ')) + ' — ' + esc(h.status) +
      '<div class="meta">created ' + fmtDate(h.createdAt) + (h.submittedAt ? ' · submitted ' + fmtWhen(h.submittedAt) : '') + '</div></li>').join('') + '</ul>';

  if (p.letterDocumentId) {
    fetch('/api/documents/' + p.letterDocumentId + '/content')
      .then((r) => r.text()).then((t) => $('#letter').textContent = t)
      .catch(() => $('#letter').textContent = 'letter unavailable');
  } else $('#letter').textContent = 'no letter';

  $('#btn-upload2').addEventListener('click', () => openModal('m-upload'));
  $('#btn-submit')?.addEventListener('click', () => doSubmit(false));
  $('#btn-mailed')?.addEventListener('click', () => doSubmit(true));
  async function doSubmit(manual) {
    try {
      const method = manual ? (prompt('Method (mail/fax):', 'mail') || 'mail') : p.submissionMethod;
      if (!method) return;
      await api('/api/packets/' + p.packetId + '/submit', { method: 'POST',
        body: JSON.stringify({ method, manual }) });
      toast(manual ? 'Marked as sent via ' + method : 'Submitted via ' + method);
      load();
    } catch (e) { toast(e.message, true); }
  }
}

$('#btn-note').addEventListener('click', async () => {
  const notes = $('#note').value.trim();
  if (!notes) return;
  await api('/api/cases/' + caseId + '/note', { method: 'POST', body: JSON.stringify({ notes }) });
  $('#note').value = ''; toast('note added'); load();
});
$('#btn-call').addEventListener('click', () => openModal('m-call'));
$('#call-go').addEventListener('click', async () => {
  try {
    await api('/api/cases/' + caseId + '/call', { method: 'POST',
      body: JSON.stringify({ outcome: $('#call-outcome').value, notes: $('#call-notes').value }) });
    closeModal('m-call'); toast('call logged'); load();
  } catch (e) { toast(e.message, true); }
});
$('#assign-go').addEventListener('click', async () => {
  try {
    await api('/api/cases/' + caseId + '/assign', { method: 'POST',
      body: JSON.stringify({ userId: $('#assign-user').value || null }) });
    closeModal('m-assign'); toast('reassigned'); load();
  } catch (e) { toast(e.message, true); }
});
$('#up-go').addEventListener('click', async () => {
  const f = $('#up-file').files[0];
  if (!f) return toast('choose a file', true);
  const res = await fetch('/api/cases/' + caseId + '/documents?filename=' +
    encodeURIComponent(f.name) + '&type=' + $('#up-type').value,
    { method: 'POST', body: f });
  const body = await res.json();
  if (!res.ok) return toast(body.error || 'upload failed', true);
  closeModal('m-upload');
  toast('uploaded' + (body.packet ? ' — packet now ' + body.packet.packetStatus : ''));
  load();
});
load();`;

// ---------------------------------------------------------------------------

export const BUILDER_BODY = `
<div class="steps" id="steps">
  <span class="on">1 Find claim</span><span>2 Identify issue</span>
  <span>3 Review documents</span><span>4 Deadline &amp; assign</span><span>5 Create</span>
</div>
<div class="panel" id="step1">
  <h2>Step 1 — Find claim</h2>
  <div class="filters"><label>Search (patient name, claim number, DOS)
    <input id="q" style="width:320px" placeholder="e.g. DOE or CLM-1001 or 2026-06-01"></label>
    <button class="btn primary" id="btn-search">Search</button></div>
  <table class="data" id="results"><tbody></tbody></table>
</div>
<div class="panel" id="step2" style="display:none;margin-top:14px">
  <h2>Step 2 — Identify issue</h2>
  <div id="claim-summary" class="sub" style="margin-bottom:10px"></div>
  <div class="filters">
    <label>Claim line<select id="b-line"></select></label>
    <label>Case type<select id="b-type">
      <option>underpayment</option><option>denial</option><option>timely_filing</option>
      <option>authorization</option><option>duplicate</option><option>bundling</option><option>other</option></select></label>
    <label>Denial reason code<input id="b-code" placeholder="e.g. CO-197" style="width:110px"></label>
    <button class="btn" id="btn-classify">Classify</button>
  </div>
  <div id="reco" class="sub"></div>
</div>
<div class="panel" id="step3" style="display:none;margin-top:14px">
  <h2>Step 3 — Review documents</h2>
  <div class="sub">The appeal letter is generated automatically when the case is created.
  Expected checklist for this category:</div>
  <ul class="checklist" id="doc-plan"></ul>
</div>
<div class="panel" id="step4" style="display:none;margin-top:14px">
  <h2>Step 4 — Deadline &amp; assign</h2>
  <div class="filters">
    <label>Deadline<input type="date" id="b-deadline"></label>
    <label>Assign to<select id="b-assign"><option value="">— leave in queue —</option></select></label>
    <label>Note<input id="b-note" style="width:260px"></label>
  </div>
  <div class="sub" id="deadline-hint"></div>
</div>
<div class="panel" id="step5" style="display:none;margin-top:14px">
  <h2>Step 5 — Create</h2>
  <button class="btn primary" id="btn-create">Create case &amp; generate packet</button>
  <div id="outcome" style="margin-top:10px"></div>
</div>`;

export const BUILDER_JS = `
let picked = null, reco = null;
const DOC_PLANS = {
  authorization: ['appeal letter (generated)', 'EOB summary (generated)', 'claim lines (generated)', 'authorization record'],
  clinical_medical_necessity: ['appeal letter (generated)', 'EOB summary (generated)', 'claim lines (generated)', 'medical record (upload required)'],
  contractual: ['appeal letter (generated)', 'EOB summary (generated)', 'claim lines (generated)', 'contract excerpt (generated)'],
  timely_filing: ['appeal letter (generated)', 'EOB summary (generated)', 'claim lines (generated)', 'proof of timely filing'],
  default: ['appeal letter (generated)', 'EOB summary (generated)', 'claim lines (generated)'],
};
function setStep(n) { $$('#steps span').forEach((s, i) => s.classList.toggle('on', i < n)); }

async function search() {
  const rows = await api('/api/claims/search?q=' + encodeURIComponent($('#q').value));
  $('#results tbody').innerHTML =
    '<tr><th>Claim</th><th>Patient</th><th>Payer</th><th>DOS</th><th class="num">Billed</th><th>Status</th><th></th></tr>' +
    rows.map((r) => '<tr><td>' + esc(r.number) + '</td><td>' + esc(r.patientName) + '</td>' +
      '<td>' + esc(r.payerName) + '</td><td>' + fmtDate(r.dos) + '</td>' +
      '<td class="num">' + usd(r.billed) + '</td><td>' + stBadge(r.status) + '</td>' +
      '<td>' + (r.hasOpenCase ? '<span class="sub">open case exists</span>'
        : '<button class="btn small" data-id="' + r.claimId + '">Select</button>') + '</td></tr>').join('')
    || '<tr><td class="sub">no claims found</td></tr>';
  $$('#results button').forEach((b) => b.addEventListener('click', () => pick(b.dataset.id)));
}
async function pick(claimId) {
  picked = await api('/api/claims/' + claimId);
  $('#claim-summary').innerHTML = '<b>' + esc(picked.number) + '</b> — ' + esc(picked.patientName) +
    ' · ' + esc(picked.payerName) + ' · DOS ' + fmtDate(picked.dos) + ' · billed ' + usd(picked.billed);
  $('#b-line').innerHTML = '<option value="">whole claim</option>' + picked.lines.map((l) =>
    '<option value="' + l.claimLineId + '">line ' + l.lineNumber + ' — ' + esc(l.procedureCode) +
    (l.denialCode ? ' (' + esc(l.denialCode) + ')' : '') + '</option>').join('');
  const denied = picked.lines.find((l) => l.denialCode);
  if (denied) { $('#b-code').value = denied.denialCode; $('#b-line').value = denied.claimLineId; }
  $('#step2').style.display = ''; setStep(2);
}
async function classify() {
  reco = await api('/api/recommendation?code=' + encodeURIComponent($('#b-code').value) +
    '&payerId=' + picked.payerId);
  if (reco.caseType) $('#b-type').value = reco.caseType;
  $('#reco').innerHTML = '<b>System recommendation:</b> ' + esc(reco.recommendedAction) +
    (reco.category ? ' <span class="badge st">' + esc(reco.category.replaceAll('_',' ')) + '</span>' : '') +
    (reco.baseLikelihood ? ' · likelihood ' + esc(reco.baseLikelihood) : '');
  const plan = DOC_PLANS[reco.category] || DOC_PLANS.default;
  $('#doc-plan').innerHTML = plan.map((d) => '<li class="ok">' + esc(d) + '</li>').join('');
  $('#b-deadline').value = reco.suggestedDeadline;
  $('#deadline-hint').textContent = 'Suggested from payer appeal window: ' +
    reco.suggestedDeadline + ' (' + reco.deadlineDays + ' days)';
  $('#step3').style.display = ''; $('#step4').style.display = ''; $('#step5').style.display = '';
  setStep(5);
}
$('#btn-search').addEventListener('click', search);
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
$('#btn-classify').addEventListener('click', () => classify().catch((e) => toast(e.message, true)));
(async () => {
  const l = await api('/api/lookups');
  $('#b-assign').innerHTML += l.users.map((u) => '<option value="' + u.id + '">' + esc(u.name) + '</option>').join('');
})();
$('#btn-create').addEventListener('click', async () => {
  try {
    const r = await api('/api/cases', { method: 'POST', body: JSON.stringify({
      claimId: picked.claimId,
      claimLineId: $('#b-line').value || null,
      caseType: $('#b-type').value,
      denialReasonCode: $('#b-code').value || null,
      deadlineDate: $('#b-deadline').value || null,
      assignTo: $('#b-assign').value || null,
      notes: $('#b-note').value || null,
    }) });
    $('#outcome').innerHTML = '<div class="badge ready">case created</div> recovery ' + usd(r.recovery) +
      ' · priority ' + esc(r.priority) +
      (r.packet ? ' · packet ' + esc(r.packet.packetStatus) : '') +
      ' — <a href="/case/' + r.caseId + '"><b>open case →</b></a>';
    toast('case created');
  } catch (e) { toast(e.message, true); }
});`;

// ---------------------------------------------------------------------------

export const PAYERS_BODY = `
<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
  <button class="btn" id="btn-csv">Export CSV</button></div>
<div class="panel"><table class="data" id="tbl"><tbody></tbody></table></div>
<div class="grid2" id="detail" style="display:none">
  <div class="panel"><h2 id="drill-title">Claims</h2>
    <table class="data" id="drill"><tbody></tbody></table></div>
  <div class="panel"><h2 id="trend-title">Monthly paid trend</h2><div id="trend"></div></div>
</div>`;

export const PAYERS_JS = `
let data = [];
(async () => {
  data = (await api('/api/reports/payers')).payers;
  $('#tbl tbody').innerHTML =
    '<tr><th>Payer</th><th class="num">Claims</th><th class="num">Expected</th><th class="num">Paid</th>' +
    '<th class="num">Variance</th><th class="num">Var %</th><th class="num">Avg days to pay</th>' +
    '<th class="num">Appeals</th><th class="num">Won</th><th class="num">Won rate</th><th class="num">Recovered</th><th>Top denial categories</th></tr>' +
    data.map((p, i) => '<tr class="drill" data-i="' + i + '"><td><b>' + esc(p.payerName) + '</b></td>' +
      '<td class="num">' + p.claimsSubmitted + '</td><td class="num">' + usd(p.expected) + '</td>' +
      '<td class="num">' + usd(p.paid) + '</td><td class="num deadline-red">' + usd(p.variance) + '</td>' +
      '<td class="num">' + p.variancePct + '%</td><td class="num">' + (p.avgDaysToPay ?? '—') + '</td>' +
      '<td class="num">' + p.appealsSubmitted + '</td><td class="num">' + p.appealsWon + '</td>' +
      '<td class="num">' + (p.wonRate == null ? '—' : p.wonRate + '%') + '</td>' +
      '<td class="num">' + usd(p.totalRecovered) + '</td>' +
      '<td>' + p.denialRateByCategory.slice(0, 3).map((d) =>
        esc(d.category.replaceAll('_',' ')) + ' ' + d.pct + '%').join(' · ') + '</td></tr>').join('');
  $$('#tbl .drill').forEach((tr) => tr.addEventListener('click', () => drill(data[tr.dataset.i])));
})();
async function drill(p) {
  $('#detail').style.display = '';
  $('#drill-title').textContent = p.payerName + ' — claim detail';
  $('#trend-title').textContent = p.payerName + ' — monthly paid trend';
  const rows = (await api('/api/reports/payers/' + p.payerId + '/claims')).claims;
  $('#drill tbody').innerHTML =
    '<tr><th>Claim</th><th>Patient</th><th>DOS</th><th class="num">Billed</th><th class="num">Expected</th>' +
    '<th class="num">Paid</th><th class="num">Variance</th><th>Status</th><th class="num">Cases</th></tr>' +
    rows.map((r) => '<tr><td>' + esc(r.number) + '</td><td>' + esc(r.patientName) + '</td>' +
      '<td>' + fmtDate(r.dos) + '</td><td class="num">' + usd(r.billed) + '</td>' +
      '<td class="num">' + usd(r.expected) + '</td><td class="num">' + usd(r.paid) + '</td>' +
      '<td class="num ' + (r.variance > 0 ? 'deadline-red' : '') + '">' + usd(r.variance) + '</td>' +
      '<td>' + stBadge(r.status) + '</td><td class="num">' + r.cases + '</td></tr>').join('');
  lineChart($('#trend'), p.monthTrend.map((t) => t.month),
    [{ name: 'paid', color: '#1f4e8c', values: p.monthTrend.map((t) => t.paid) }]);
}
$('#btn-csv').addEventListener('click', () => downloadCsv(data.map((p) => ({
  payer: p.payerName, claims: p.claimsSubmitted, expected: p.expected, paid: p.paid,
  variance: p.variance, variance_pct: p.variancePct, avg_days_to_pay: p.avgDaysToPay,
  appeals_submitted: p.appealsSubmitted, appeals_won: p.appealsWon, won_rate: p.wonRate,
  recovered: p.totalRecovered })), 'payer-performance.csv'));`;

// ---------------------------------------------------------------------------

export const DENIALS_BODY = `
<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px">
  <button class="btn" id="btn-csv">Export CSV</button>
  <button class="btn" onclick="window.print()">Export PDF</button></div>
<div class="grid2">
  <div class="panel"><h2>Denial categories ($ at risk)</h2><div id="donut"></div></div>
  <div class="panel"><h2>Denial trend by month</h2><div id="trend"></div></div>
</div>
<div class="grid2">
  <div class="panel"><h2>Top denial codes</h2><table class="data" id="codes"><tbody></tbody></table></div>
  <div class="panel"><h2>Avoidable vs unavoidable · root causes</h2>
    <div id="avoid"></div><div id="root" style="margin-top:12px"></div></div>
</div>
<div class="grid2">
  <div class="panel"><h2>Denial rate by provider</h2><table class="data" id="prov"><tbody></tbody></table></div>
  <div class="panel"><h2>Denial rate by procedure code</h2><table class="data" id="proc"><tbody></tbody></table></div>
</div>`;

export const DENIALS_JS = `
let d = null;
(async () => {
  d = await api('/api/reports/denials');
  donutChart($('#donut'), d.categories.map((c) => ({ label: c.category.replaceAll('_',' '), value: c.amount })));
  const months = [...new Set(d.monthlyTrend.map((m) => m.month))].sort();
  const totals = months.map((m) => d.monthlyTrend.filter((x) => x.month === m).reduce((a, x) => a + x.count, 0));
  lineChart($('#trend'), months, [{ name: 'denials', color: '#c0392b',
    values: totals }]);
  $('#codes tbody').innerHTML = '<tr><th>Code</th><th class="num">Count</th><th class="num">Dollars</th></tr>' +
    d.topCodes.map((c) => '<tr><td>' + esc(c.code) + '</td><td class="num">' + c.count + '</td>' +
      '<td class="num">' + usd(c.amount) + '</td></tr>').join('');
  hbarChart($('#avoid'), d.avoidability.map((a) => ({ label: a.classification.replaceAll('_',' '), value: a.amount })));
  hbarChart($('#root'), d.rootCauses.map((r) => ({ label: r.rootCause.replaceAll('_',' '), value: r.amount })), { alt: true });
  $('#prov tbody').innerHTML = '<tr><th>Provider</th><th class="num">Claims</th><th class="num">Denials</th><th class="num">Rate</th></tr>' +
    d.byProvider.map((p) => '<tr><td>' + esc(p.provider) + '</td><td class="num">' + p.claims + '</td>' +
      '<td class="num">' + p.denials + '</td><td class="num">' + p.rate + '%</td></tr>').join('');
  $('#proc tbody').innerHTML = '<tr><th>Code</th><th class="num">Lines</th><th class="num">Denied</th><th class="num">Rate</th></tr>' +
    d.byProcedure.map((p) => '<tr><td>' + esc(p.procedureCode) + '</td><td class="num">' + p.lines + '</td>' +
      '<td class="num">' + p.denied + '</td><td class="num">' + p.rate + '%</td></tr>').join('');
})();
$('#btn-csv').addEventListener('click', () => downloadCsv(d.categories.map((c) => ({
  category: c.category, count: c.count, dollars: c.amount,
  classification: c.avoidable, root_cause: c.rootCause })), 'denial-analytics.csv'));`;

// ---------------------------------------------------------------------------

export const RECON_BODY = `
<div class="cards">
  <div class="card"><h3>Recovered (period)</h3><div class="big" id="k-rec">—</div>
    <div class="sub" id="k-period"></div></div>
  <div class="card"><h3>Auto-matched</h3><div class="big" id="k-auto">—</div></div>
  <div class="card alarm"><h3>Unmatched — needs manual match</h3><div class="big" id="k-un">—</div></div>
</div>
<div class="grid2">
  <div class="panel"><h2>Unmatched post-appeal remittances</h2>
    <table class="data" id="unmatched"><tbody></tbody></table></div>
  <div class="panel"><h2>Recovery rate by category</h2><div id="rates"></div></div>
</div>
<div class="panel" style="margin-top:14px"><h2>Matched recoveries</h2>
  <table class="data" id="matched"><tbody></tbody></table></div>
<div class="modal-back" id="m-match"><div class="modal"><h3>Match payment to case</h3>
  <div class="row">Amount<input type="number" step="0.01" id="mm-amount"></div>
  <div class="row">Payment date<input type="date" id="mm-date"></div>
  <div class="row"><label><input type="checkbox" id="mm-won" checked> mark case won</label></div>
  <div class="actions"><button class="btn" onclick="closeModal('m-match')">Cancel</button>
  <button class="btn primary" id="mm-go">Match</button></div></div></div>`;

export const RECON_JS = `
let d = null, target = null;
async function load() {
  d = await api('/api/reports/reconciliation');
  $('#k-rec').textContent = usd(d.totalRecovered);
  $('#k-period').textContent = 'last ' + d.periodDays + ' days';
  $('#k-auto').textContent = d.autoMatched.length;
  $('#k-un').textContent = d.unmatched.length;
  $('#unmatched tbody').innerHTML =
    '<tr><th>Claim</th><th>Patient</th><th>Payer</th><th class="num">Paid</th><th>Check</th><th>Appealed</th><th></th></tr>' +
    d.unmatched.map((u, i) => '<tr><td>' + esc(u.claimNumber) + '</td><td>' + esc(u.patientName) + '</td>' +
      '<td>' + esc(u.payerName) + '</td><td class="num">' + usd(u.paid) + '</td>' +
      '<td>' + esc(u.checkNumber || '—') + ' ' + fmtDate(u.checkDate) + '</td>' +
      '<td>' + fmtDate(u.appealSubmittedAt) + '</td>' +
      '<td><button class="btn small" data-i="' + i + '">Match</button></td></tr>').join('')
    || '<tr><td class="sub" colspan="7">nothing awaiting manual match</td></tr>';
  const all = [...d.autoMatched, ...d.manualMatched].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('#matched tbody').innerHTML =
    '<tr><th>Date</th><th>Claim</th><th>Patient</th><th>Payer</th><th>Category</th>' +
    '<th class="num">Amount</th><th>Matched</th><th>Verified by</th></tr>' +
    all.map((m) => '<tr><td>' + fmtDate(m.date) + '</td><td><a href="/case/' + m.caseId + '">' + esc(m.claimNumber) + '</a></td>' +
      '<td>' + esc(m.patientName) + '</td><td>' + esc(m.payerName) + '</td>' +
      '<td>' + esc((m.category || '').replaceAll('_',' ')) + '</td>' +
      '<td class="num">' + usd(m.amount) + '</td>' +
      '<td>' + (m.verifiedBy ? 'manually' : 'automatically') + '</td>' +
      '<td>' + esc(m.verifiedBy || 'system') + '</td></tr>').join('')
    || '<tr><td class="sub" colspan="8">no recoveries in this period</td></tr>';
  hbarChart($('#rates'), d.recoveryRateByCategory.map((r) =>
    ({ label: r.category.replaceAll('_',' ') + ' (' + r.rate + '%)', value: r.recovered })));
  $$('#unmatched button').forEach((b) => b.addEventListener('click', () => {
    target = d.unmatched[b.dataset.i];
    $('#mm-amount').value = target.paid;
    $('#mm-date').value = target.checkDate || new Date().toISOString().slice(0, 10);
    openModal('m-match');
  }));
}
$('#mm-go').addEventListener('click', async () => {
  try {
    await api('/api/reconciliation/match', { method: 'POST', body: JSON.stringify({
      caseId: target.caseId, remittanceId: target.remittanceId,
      amount: Number($('#mm-amount').value), date: $('#mm-date').value,
      markWon: $('#mm-won').checked }) });
    closeModal('m-match'); toast('payment matched'); load();
  } catch (e) { toast(e.message, true); }
});
load();`;

// ---------------------------------------------------------------------------

export const WORKLOAD_BODY = `
<div class="panel"><h2>Cases by assignee</h2><table class="data" id="tbl"><tbody></tbody></table></div>
<div class="panel" style="margin-top:14px"><h2>Productivity trend (actions per week)</h2><div id="trend"></div></div>`;

export const WORKLOAD_JS = `
(async () => {
  const d = await api('/api/reports/workload');
  const users = d.users;
  $('#tbl tbody').innerHTML =
    '<tr><th>User</th><th>Role</th><th class="num">Open cases</th><th class="num">Open $</th>' +
    '<th class="num">Overdue</th><th class="num">Actions this week</th><th class="num">SLA compliance</th></tr>' +
    users.map((u) => '<tr><td><b>' + esc(u.name) + '</b></td><td>' + esc(u.role.replaceAll('_',' ')) + '</td>' +
      '<td class="num">' + u.openCases + '</td><td class="num">' + usd(u.openAmount) + '</td>' +
      '<td class="num ' + (u.overdue > 0 ? 'deadline-red' : '') + '">' + u.overdue + '</td>' +
      '<td class="num">' + u.actionsThisWeek + '</td>' +
      '<td class="num">' + (u.slaCompliancePct == null ? '—' : u.slaCompliancePct + '%') + '</td></tr>').join('');
  const weeks = [...new Set(users.flatMap((u) => u.trend.map((t) => t.week)))].sort();
  const colors = ['#1f4e8c', '#b9770e', '#1e8449', '#c0392b', '#7d3c98'];
  const active = users.filter((u) => u.trend.length > 0).slice(0, 5);
  if (weeks.length && active.length) {
    lineChart($('#trend'), weeks, active.map((u, i) => ({
      name: u.name, color: colors[i % 5],
      values: weeks.map((w) => u.trend.find((t) => t.week === w)?.actions ?? 0) })));
  } else $('#trend').innerHTML = '<div class="sub">no user actions recorded yet</div>';
})();`;

// ---------------------------------------------------------------------------

export const NOTIFS_BODY = `
<div class="grid3">
  <div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h2 style="margin:0">Notifications</h2>
      <div style="display:flex;gap:8px">
        <label class="sub"><input type="checkbox" id="unread-only"> unread only</label>
        <button class="btn small" id="mark-all">Mark all read</button>
      </div>
    </div>
    <ul class="feed" id="list"></ul>
  </div>
  <div class="panel"><h2>Preferences</h2>
    <div class="row" style="margin-bottom:10px">
      <label class="sub">Email digest frequency
        <select id="pref-freq" style="margin-left:8px">
          <option value="daily">daily</option><option value="weekly">weekly</option>
          <option value="off">off</option></select>
      </label>
    </div>
    <table class="data" id="prefs"><tbody></tbody></table>
    <div style="margin-top:10px"><button class="btn primary" id="save-prefs">Save preferences</button></div>
  </div>
</div>`;

export const NOTIFS_JS = `
async function load() {
  const unread = $('#unread-only').checked;
  const rows = await api('/api/notifications' + (unread ? '?unread=1' : ''));
  $('#list').innerHTML = rows.map((n) =>
    '<li style="' + (n.read ? 'opacity:.6' : '') + '">' +
    (n.severity === 'urgent' ? '<span class="badge critical">urgent</span> ' :
     n.severity === 'warning' ? '<span class="badge high">warning</span> ' : '') +
    '<b>' + esc(n.title) + '</b>' +
    (n.body ? '<div>' + esc(n.body) + '</div>' : '') +
    '<div class="meta">' + fmtWhen(n.createdAt) + ' · ' + esc(n.type.replaceAll('_',' ')) +
    (n.caseId ? ' · <a href="/case/' + n.caseId + '">open case</a>' : '') +
    (!n.read ? ' · <a href="#" data-id="' + n.notificationId + '" class="mark">mark read</a>' : '') +
    '</div></li>').join('') || '<li class="sub">no notifications</li>';
  $$('.mark').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/notifications/' + a.dataset.id + '/read', { method: 'POST', body: '{}' });
    load();
  }));
}
async function loadPrefs() {
  const p = await api('/api/notification-preferences');
  $('#pref-freq').value = p.digestFrequency;
  $('#prefs tbody').innerHTML =
    '<tr><th>Type</th><th>In-app</th><th>Email</th></tr>' +
    p.types.map((t) => '<tr data-type="' + t.type + '">' +
      '<td>' + esc(t.type.replaceAll('_',' ')) + '</td>' +
      '<td><input type="checkbox" class="p-inapp"' + (t.inApp ? ' checked' : '') + '></td>' +
      '<td><select class="p-email">' +
        ['immediate','digest','off'].map((m) =>
          '<option' + (t.email === m ? ' selected' : '') + '>' + m + '</option>').join('') +
      '</select></td></tr>').join('');
}
$('#save-prefs').addEventListener('click', async () => {
  const types = $$('#prefs tr[data-type]').map((tr) => ({
    type: tr.dataset.type,
    inApp: $('.p-inapp', tr).checked,
    email: $('.p-email', tr).value,
  }));
  await api('/api/notification-preferences', { method: 'POST',
    body: JSON.stringify({ digestFrequency: $('#pref-freq').value, types }) });
  toast('preferences saved');
});
$('#mark-all').addEventListener('click', async () => {
  await api('/api/notifications/all/read', { method: 'POST', body: '{}' });
  load();
});
$('#unread-only').addEventListener('change', load);
load(); loadPrefs();`;

// ---------------------------------------------------------------------------

export const RULES_BODY = `
<div class="grid3">
  <div class="panel">
    <h2>Automation rules</h2>
    <table class="data" id="rules"><tbody></tbody></table>
    <h2 style="margin-top:16px">Recent executions</h2>
    <ul class="feed" id="execs"></ul>
  </div>
  <div class="panel"><h2>New rule</h2>
    <div class="row" style="margin-bottom:8px">
      <input id="r-name" placeholder="Rule name" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:7px">
    </div>
    <div class="filters" style="margin-bottom:4px">
      <label>WHEN<select id="r-trigger">
        <option value="case_created">new case created</option>
        <option value="deadline_approaching">deadline approaching</option>
        <option value="payment_received">payment received</option>
        <option value="status_changed">status changed</option>
        <option value="document_uploaded">document uploaded</option></select></label>
      <label id="r-days-wrap" style="display:none">within days
        <input type="number" id="r-days" value="7" style="width:70px"></label>
    </div>
    <div class="sub" style="margin:6px 0 2px">AND (all conditions must match)</div>
    <div id="conds"></div>
    <button class="btn small" id="add-cond">+ condition</button>
    <div class="sub" style="margin:12px 0 2px">THEN</div>
    <div id="acts"></div>
    <button class="btn small" id="add-act">+ action</button>
    <div style="margin-top:14px"><button class="btn primary" id="create-rule">Create rule</button></div>
  </div>
</div>`;

export const RULES_JS = `
let lookups = null;
const FIELDS = [
  ['payer_id', 'payer'], ['denial_category', 'denial category'],
  ['recovery_opportunity', 'recovery opportunity $'],
  ['confidence_score', 'confidence score (0-1)'], ['case_type', 'case type']];
const OPS = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
const CASE_TYPES = ['underpayment','denial','timely_filing','authorization','duplicate','bundling','other'];
const CATEGORIES = ['clinical_medical_necessity','authorization','coding','timely_filing',
  'duplicate','coordination_of_benefits','contractual','patient_eligibility','bundling'];

function condRow() {
  const div = document.createElement('div');
  div.className = 'filters'; div.style.marginBottom = '2px';
  div.innerHTML =
    '<select class="c-field">' + FIELDS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select>' +
    '<select class="c-op">' + Object.entries(OPS).map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select>' +
    '<span class="c-value-wrap"></span>' +
    '<button class="btn small c-del">×</button>';
  const sync = () => {
    const f = $('.c-field', div).value;
    const wrap = $('.c-value-wrap', div);
    if (f === 'payer_id') wrap.innerHTML = '<select class="c-value">' +
      lookups.payers.map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select>';
    else if (f === 'denial_category') wrap.innerHTML = '<select class="c-value">' +
      CATEGORIES.map((c) => '<option>' + c + '</option>').join('') + '</select>';
    else if (f === 'case_type') wrap.innerHTML = '<select class="c-value">' +
      CASE_TYPES.map((c) => '<option>' + c + '</option>').join('') + '</select>';
    else wrap.innerHTML = '<input type="number" step="any" class="c-value" style="width:110px">';
  };
  $('.c-field', div).addEventListener('change', sync); sync();
  $('.c-del', div).addEventListener('click', () => div.remove());
  return div;
}
function actRow() {
  const div = document.createElement('div');
  div.className = 'filters'; div.style.marginBottom = '2px';
  div.innerHTML =
    '<select class="a-type">' +
    '<option value="assign_to">auto assign to</option>' +
    '<option value="notify">send notification to</option>' +
    '<option value="set_priority">set priority to</option>' +
    '<option value="add_to_submission_queue">add to submission queue</option>' +
    '<option value="flag_for_review">flag for review</option></select>' +
    '<span class="a-param-wrap"></span>' +
    '<button class="btn small a-del">×</button>';
  const sync = () => {
    const t = $('.a-type', div).value;
    const wrap = $('.a-param-wrap', div);
    if (t === 'assign_to') wrap.innerHTML = '<select class="a-user">' +
      lookups.users.map((u) => '<option value="' + u.id + '">' + esc(u.name) + '</option>').join('') + '</select>';
    else if (t === 'notify') wrap.innerHTML = '<select class="a-target">' +
      '<option value="role:client_admin">role: client admin</option>' +
      '<option value="role:tenant_admin">role: tenant admin</option>' +
      '<option value="role:biller">role: biller</option>' +
      '<option value="role:collector">role: collector</option>' +
      lookups.users.map((u) => '<option value="user:' + u.id + '">' + esc(u.name) + '</option>').join('') + '</select>';
    else if (t === 'set_priority') wrap.innerHTML = '<select class="a-level">' +
      ['critical','high','medium','low'].map((l) => '<option>' + l + '</option>').join('') + '</select>';
    else wrap.innerHTML = '';
  };
  $('.a-type', div).addEventListener('change', sync); sync();
  $('.a-del', div).addEventListener('click', () => div.remove());
  return div;
}
function describeRule(r) {
  const conds = (r.conditions || []).map((c) =>
    c.field.replaceAll('_',' ') + ' ' + (OPS[c.op] || c.op) + ' ' +
    (c.field === 'payer_id' ? (lookups.payers.find((p) => p.id === c.value)?.name ?? c.value) : c.value));
  const acts = (r.actions || []).map((a) =>
    a.type === 'assign_to' ? 'assign to ' + (lookups.users.find((u) => u.id === a.userId)?.name ?? a.userId)
    : a.type === 'notify' ? 'notify ' + (a.role ? 'role ' + a.role : (lookups.users.find((u) => u.id === a.userId)?.name ?? a.userId))
    : a.type === 'set_priority' ? 'set priority ' + a.level
    : a.type.replaceAll('_',' '));
  return 'WHEN ' + r.trigger.replaceAll('_',' ') +
    (r.trigger === 'deadline_approaching' ? ' (' + (r.triggerParam?.days ?? 14) + 'd)' : '') +
    (conds.length ? ' AND ' + conds.join(' AND ') : '') +
    ' THEN ' + acts.join(', ');
}
async function load() {
  const rules = await api('/api/rules');
  $('#rules tbody').innerHTML =
    '<tr><th>Rule</th><th class="num">Fired</th><th></th><th></th></tr>' +
    rules.map((r) => '<tr><td><b>' + esc(r.name) + '</b>' +
      (r.enabled ? '' : ' <span class="badge lost">disabled</span>') +
      '<div class="sub">' + esc(describeRule(r)) + '</div></td>' +
      '<td class="num">' + r.executions + '</td>' +
      '<td><button class="btn small" data-t="' + r.ruleId + '">' + (r.enabled ? 'Disable' : 'Enable') + '</button></td>' +
      '<td><button class="btn small danger" data-d="' + r.ruleId + '">Delete</button></td></tr>').join('')
    || '<tr><td class="sub">no rules configured</td></tr>';
  $$('#rules [data-t]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/rules/' + b.dataset.t + '/toggle', { method: 'POST', body: '{}' }); load();
  }));
  $$('#rules [data-d]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/rules/' + b.dataset.d + '/delete', { method: 'POST', body: '{}' }); load();
  }));
  const execs = await api('/api/rules/executions');
  $('#execs').innerHTML = execs.map((e) =>
    '<li><b>' + esc(e.ruleName) + '</b> fired on <a href="/case/' + e.caseId + '">' +
    esc(e.claimNumber) + '</a><div class="meta">' + fmtWhen(e.executedAt) + ' · ' +
    esc(e.trigger.replaceAll('_',' ')) + ' → ' + esc((e.actionsApplied || []).join('; ')) +
    '</div></li>').join('') || '<li class="sub">no executions yet</li>';
}
$('#r-trigger').addEventListener('change', () => {
  $('#r-days-wrap').style.display =
    $('#r-trigger').value === 'deadline_approaching' ? '' : 'none';
});
$('#add-cond').addEventListener('click', () => $('#conds').appendChild(condRow()));
$('#add-act').addEventListener('click', () => $('#acts').appendChild(actRow()));
$('#create-rule').addEventListener('click', async () => {
  const conditions = $$('#conds > div').map((d) => ({
    field: $('.c-field', d).value, op: $('.c-op', d).value,
    value: $('.c-value', d).value,
  }));
  const actions = $$('#acts > div').map((d) => {
    const type = $('.a-type', d).value;
    if (type === 'assign_to') return { type, userId: $('.a-user', d).value };
    if (type === 'notify') {
      const [kind, val] = $('.a-target', d).value.split(':');
      return kind === 'role' ? { type, role: val } : { type, userId: val };
    }
    if (type === 'set_priority') return { type, level: $('.a-level', d).value };
    return { type };
  });
  try {
    await api('/api/rules', { method: 'POST', body: JSON.stringify({
      name: $('#r-name').value,
      trigger: $('#r-trigger').value,
      triggerParam: $('#r-trigger').value === 'deadline_approaching'
        ? { days: Number($('#r-days').value) || 7 } : {},
      conditions, actions,
    }) });
    toast('rule created'); $('#r-name').value = '';
    $('#conds').innerHTML = ''; $('#acts').innerHTML = '';
    load();
  } catch (e) { toast(e.message, true); }
});
(async () => {
  lookups = await api('/api/lookups');
  $('#acts').appendChild(actRow());
  load();
})();`;
