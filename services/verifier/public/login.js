/* Shared login UI for both relying-party demos (OpenID4VP cross-device flow). */
window.Login = (function () {
  const $ = (id) => document.getElementById(id);
  async function start({ tenant, flow, titleKey, asks, render }) {
    await App.init({ tenant, titleKey });
    let me = null;
    const show = () => {
      $('login').classList.toggle('hidden', !!me); $('account').classList.toggle('hidden', !me); $('logout').classList.toggle('hidden', !me);
      if (me) $('account').innerHTML = render(me, App.esc, App.t);
    };
    document.addEventListener('langchange', () => { if (me) show(); renderAsks(); });
    const renderAsks = () => { $('asks').innerHTML = asks.map((k) => '<li>' + App.esc(App.t(k)) + '</li>').join(''); };
    try { me = await App.api('/api/me?flow=' + flow); } catch { me = null; }
    show(); renderAsks();
    let stop;
    $('go').onclick = async () => {
      $('err').classList.add('hidden'); if (stop) stop();
      try {
        const s = await App.api('/api/sessions', { method: 'POST', body: { flow } });
        $('box').classList.remove('hidden'); $('qrbox').classList.remove('hidden'); $('go').classList.add('hidden');
        $('qr').src = App.qrUrl(s.request_uri); $('deep').href = s.request_uri;
        stop = App.poll(async () => {
          const r = await fetch('/api/sessions/' + s.id + '?token=' + encodeURIComponent(s.poll_token), { cache: 'no-store' });
          if (r.status === 404) { fail('v.expired'); return true; }
          const j = await r.json();
          if (j.status === 'verified') { me = await App.api('/api/me?flow=' + flow); show(); return true; }
          if (j.status === 'rejected') { fail('v.rejected', j.error); return true; }
          return false;
        }, 1500);
      } catch (e) { fail('v.failed'); }
    };
    function fail(key, detail) {
      $('err').textContent = App.t(key) + (detail ? ' (' + detail + ')' : ''); $('err').classList.remove('hidden');
      $('go').classList.remove('hidden'); $('box').classList.add('hidden'); $('qrbox').classList.add('hidden');
    }
    $('logout').onclick = async () => { await App.api('/api/logout', { method: 'POST', body: {} }); me = null; $('go').classList.remove('hidden'); $('box').classList.add('hidden'); $('qrbox').classList.add('hidden'); show(); };
  }
  return { start };
})();
