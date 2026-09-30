/* Shared browser runtime: i18n (en/fr/es), central branding (from the Admin portal), QR + polling helpers. */
(function () {
  const CFG = window.__CONFIG__ || {};
  const LANGS = [['en', 'English'], ['fr', 'Français'], ['es', 'Español']];
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const App = { config: CFG, lang: 'en', dict: {}, branding: null };
  window.App = App;

  const pick = () => {
    const saved = store.get('lang'); if (saved) return saved;
    const nav = (navigator.language || 'en').slice(0, 2);
    return LANGS.some((l) => l[0] === nav) ? nav : 'en';
  };

  App.t = (key, params) => {
    let s = App.dict[key] ?? key;
    if (params) for (const k of Object.keys(params)) s = s.split('{' + k + '}').join(params[k]);
    return s;
  };

  App.applyI18n = (root = document) => {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = App.t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = App.t(el.getAttribute('data-i18n-placeholder')); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = App.t(el.getAttribute('data-i18n-title')); });
    document.documentElement.lang = App.lang;
    if (App.branding) App.applyBrandName();
  };

  App.setLang = async (lang) => {
    App.lang = lang; store.set('lang', lang);
    const r = await fetch('/i18n/' + lang + '.json');
    App.dict = await r.json();
    App.applyI18n();
    document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
  };

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  App.applyBrandName = () => {
    const b = App.branding; if (!b) return;
    const name = b.names[App.lang] || b.names.en || b.tenant;
    document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = name; });
    const base = document.documentElement.getAttribute('data-title-key');
    document.title = (base ? App.t(base) + ' · ' : '') + name;
  };

  App.applyBranding = (b) => {
    App.branding = b;
    const r = document.documentElement.style;
    const dark = b.theme === 'dark' || (b.theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    r.setProperty('--primary', b.colors.primary); r.setProperty('--secondary', b.colors.secondary); r.setProperty('--accent', b.colors.accent);
    for (const [k, v] of [['--bg', b.colors.background], ['--surface', b.colors.surface], ['--text', b.colors.text]]) { if (dark) r.removeProperty(k); else r.setProperty(k, v); }
    document.querySelectorAll('img.logo').forEach((img) => { if (b.logoUrl) img.src = b.logoUrl; else img.removeAttribute('src'); });
    App.applyBrandName();
  };

  App.loadBranding = async (tenant) => {
    const cached = (() => { try { return JSON.parse(sessionStorage.getItem('brand:' + tenant)); } catch { return null; } })();
    if (cached) App.applyBranding(cached);
    else if (CFG.defaults && CFG.defaults[tenant]) App.applyBranding(CFG.defaults[tenant]);
    else if (CFG.defaultBranding) App.applyBranding(CFG.defaultBranding);
    if (!CFG.adminUrl) return;
    try {
      const r = await withTimeout(fetch(CFG.adminUrl + '/api/branding/' + tenant), 4000);
      if (r.ok) { const b = await r.json(); try { sessionStorage.setItem('brand:' + tenant, JSON.stringify(b)); } catch {} App.applyBranding(b); }
    } catch { /* keep defaults – the admin portal may be cold-starting */ }
  };

  App.langSwitcher = (mount) => {
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Language');
    LANGS.forEach(([c, l]) => { const o = document.createElement('option'); o.value = c; o.textContent = l; sel.appendChild(o); });
    sel.value = App.lang;
    sel.onchange = () => App.setLang(sel.value);
    document.addEventListener('langchange', () => { sel.value = App.lang; });
    mount.appendChild(sel);
  };

  App.qrUrl = (data) => '/api/qr?data=' + encodeURIComponent(data);
  App.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  App.api = async (path, opts = {}) => {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error_description || j.error || r.statusText); e.code = j.error; e.status = r.status; e.body = j; throw e; }
    return j;
  };
  App.poll = (fn, ms = 1500) => { let stop = false; (async function loop() { while (!stop) { try { if (await fn() === true) return; } catch {} await new Promise((r) => setTimeout(r, ms)); } })(); return () => { stop = true; }; };
  App.deepLink = (uri) => uri; // wallets register openid4vp:// and openid-credential-offer://

  App.init = async ({ tenant, titleKey } = {}) => {
    if (titleKey) document.documentElement.setAttribute('data-title-key', titleKey);
    const host = document.querySelector('[data-lang-switcher]');
    App.lang = pick();
    const dictReq = fetch('/i18n/' + App.lang + '.json').then((r) => r.json());
    if (tenant) App.loadBranding(tenant);
    App.dict = await dictReq;
    if (host) App.langSwitcher(host);
    App.applyI18n();
    document.dispatchEvent(new CustomEvent('appready'));
  };
})();
