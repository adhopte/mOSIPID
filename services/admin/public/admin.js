(async function () {
  await App.init({ titleKey: 'admin.title' });
  const $ = (id) => document.getElementById(id);
  const LANGS = [['en', 'English'], ['fr', 'Français'], ['es', 'Español']];
  const COLORS = ['primary', 'secondary', 'background', 'surface', 'text', 'accent'];
  let tenants = [], cur = null, logoData; // undefined = unchanged, null = remove, string = new

  const show = (loggedIn) => { $('login').classList.toggle('hidden', loggedIn); $('editor').classList.toggle('hidden', !loggedIn); $('logout').classList.toggle('hidden', !loggedIn); };
  const flash = (msg, ok) => { const m = $('saveMsg'); m.textContent = msg; m.className = 'msg ' + (ok ? 'ok' : 'err'); setTimeout(() => m.classList.add('hidden'), 4000); };

  async function boot() {
    const me = await App.api('/api/admin/me');
    show(me.admin);
    if (me.admin) { await loadTenants(); }
  }
  async function loadTenants() {
    tenants = await (await fetch('/api/branding', { cache: 'no-store' })).json();
    $('tenantList').innerHTML = '';
    tenants.forEach((t) => {
      const b = document.createElement('button'); b.textContent = (t.names.en || t.tenant); b.title = t.tenant; b.setAttribute('aria-current', String(cur && cur.tenant === t.tenant));
      const s = document.createElement('div'); s.className = 'muted'; s.style.fontSize = '.8rem'; s.textContent = t.tenant; b.appendChild(s);
      b.onclick = () => select(t.tenant); $('tenantList').appendChild(b);
    });
    if (!cur) select(tenants[0].tenant); else select(cur.tenant);
  }
  function select(id) {
    cur = JSON.parse(JSON.stringify(tenants.find((t) => t.tenant === id))); logoData = undefined;
    [...$('tenantList').children].forEach((b) => b.setAttribute('aria-current', String(b.title === id)));
    $('tName').textContent = cur.names.en || id; $('tKind').textContent = cur.kind; $('apiUrl').textContent = location.origin + '/api/branding/' + id;
    $('names').innerHTML = LANGS.map(([c, l]) => `<div><label for="n_${c}">${l}</label><input id="n_${c}" value="${App.esc(cur.names[c] || '')}"></div>`).join('');
    $('colors').innerHTML = COLORS.map((k) => `<div><label for="c_${k}">${App.t('admin.color.' + k)}</label><input type="color" id="c_${k}" value="${cur.colors[k]}"></div>`).join('');
    $('theme').value = cur.theme;
    const th = $('logoThumb'); if (cur.logoUrl) { th.src = cur.logoUrl; th.classList.remove('hidden'); } else th.classList.add('hidden');
    ['names', 'colors'].forEach((id2) => $(id2).oninput = preview); $('theme').onchange = preview; preview();
  }
  function read() {
    const names = {}; LANGS.forEach(([c]) => { names[c] = $('n_' + c).value; });
    const colors = {}; COLORS.forEach((k) => { colors[k] = $('c_' + k).value; });
    return { names, colors, theme: $('theme').value };
  }
  function preview() {
    const v = read(); const p = $('preview');
    p.querySelector('.bar').style.background = v.colors.secondary;
    p.style.background = v.theme === 'dark' ? '#141b2e' : v.colors.surface; p.style.color = v.theme === 'dark' ? '#e6e9f2' : v.colors.text;
    $('pvBtn').style.background = v.colors.primary; $('pvAcc').style.background = v.colors.accent;
    $('pvName').textContent = v.names[App.lang] || v.names.en;
    const src = logoData === null ? null : logoData || cur.logoUrl; const l = $('pvLogo'); if (src) { l.src = src; l.classList.remove('hidden'); } else l.classList.add('hidden');
  }
  $('logoFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 300 * 1024) { flash(App.t('admin.logoTooLarge'), false); e.target.value = ''; return; }
    const r = new FileReader(); r.onload = () => { logoData = r.result; $('logoThumb').src = logoData; $('logoThumb').classList.remove('hidden'); preview(); }; r.readAsDataURL(f);
  };
  $('logoClear').onclick = () => { logoData = null; $('logoThumb').classList.add('hidden'); preview(); };
  $('save').onclick = async () => {
    try {
      const body = read(); if (logoData !== undefined) body.logo = logoData;
      await App.api('/api/branding/' + cur.tenant, { method: 'PUT', body });
      flash(App.t('admin.saved'), true); await loadTenants();
    } catch (e) { flash(e.message, false); }
  };
  $('reset').onclick = async () => { if (!confirm(App.t('admin.confirmReset'))) return; await App.api('/api/branding/' + cur.tenant, { method: 'DELETE' }); flash(App.t('admin.resetDone'), true); await loadTenants(); };
  $('addTenant').onclick = async () => {
    const id = $('newId').value.trim(); if (!/^[a-z0-9-]{2,40}$/.test(id)) return flash(App.t('admin.badId'), false);
    try { await App.api('/api/branding/' + id, { method: 'PUT', body: { kind: id.startsWith('issuer') ? 'issuer' : 'verifier', names: { en: id } } }); $('newId').value = ''; cur = { tenant: id }; await loadTenants(); } catch (e) { flash(e.message, false); }
  };
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await App.api('/api/admin/login', { method: 'POST', body: { username: $('u').value, password: $('p').value } }); $('loginErr').classList.add('hidden'); await boot(); }
    catch (err) { $('loginErr').textContent = App.t('admin.badLogin'); $('loginErr').classList.remove('hidden'); }
  };
  $('logout').onclick = async () => { await App.api('/api/admin/logout', { method: 'POST' }); show(false); };
  document.addEventListener('langchange', () => { if (cur) { select(cur.tenant); } });
  await boot();
})();
