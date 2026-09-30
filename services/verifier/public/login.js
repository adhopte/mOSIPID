/* Sign-in dialog shared by both relying-party sites.
   Two ways to present the credential:
     • Online  – OpenID4VP: scan the QR with the wallet, or open the link on the same phone (deep link).
     • In person – ISO 18013-5: this device's camera scans the wallet's device-engagement QR; the encrypted request/response runs
                   through this verifier's relay and the result is checked server-side. */
window.Login = (function () {
  const $ = (id) => document.getElementById(id);
  const ICON = {
    online: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="9" height="15" rx="2"/><rect x="12" y="3" width="9" height="15" rx="2"/><path d="M7.5 18h.01M16.5 15h.01"/></svg>',
  };

  function modalHtml() {
    return `<div class="modal" id="lgModal" role="dialog" aria-modal="true" aria-labelledby="lgTitle"><div class="sheet">
      <header><h3 id="lgTitle" data-i18n="vs.signin.title">Sign in with your wallet</h3><button class="x" id="lgClose" aria-label="Close">×</button></header>
      <div class="body">
        <div id="lgChoose">
          <p class="muted" data-i18n="vs.choose">How do you want to present your credential?</p>
          <div class="modes">
            <button class="mode" id="lgOnline"><div class="ic">${ICON.online}</div><b data-i18n="vs.online.title">Online</b><span data-i18n="vs.online.text">Scan a QR code with your wallet, or open the link if the wallet is on this phone.</span></button>
            <button class="mode" id="lgPerson"><div class="ic">${ICON.person}</div><b data-i18n="vs.person.title">In person</b><span data-i18n="vs.person.text">Show the QR code from your wallet’s “Share in person” screen to this device’s camera.</span></button>
          </div>
        </div>
        <div id="lgOnlinePane" class="hidden">
          <ol class="stepper"><li class="on" data-i18n="vs.step.scan">Scan</li><li data-i18n="vs.step.approve">Approve</li><li data-i18n="vs.step.done">Signed in</li></ol>
          <div class="row" style="align-items:flex-start;gap:18px">
            <div class="qrbox"><img id="lgQr" alt="QR code" width="230" height="230"></div>
            <div style="flex:1;min-width:200px"><ol class="steps"><li data-i18n="v.step1">Open your wallet and tap “Scan”.</li><li data-i18n="v.step2">Scan this QR code, or open it in your wallet on this device.</li><li data-i18n="v.step3">Review what is shared and approve.</li></ol>
            <p><a id="lgDeep" class="btn" data-i18n="v.openWallet">Open in wallet</a></p>
            <p><span class="pill" id="lgStatus" data-i18n="v.waiting">Waiting for your wallet…</span></p>
            <p class="muted" data-i18n="v.willShare">This site will ask for:</p><ul id="lgAsks" class="muted"></ul></div>
          </div>
        </div>
        <div id="lgPersonPane" class="hidden">
          <ol class="stepper" id="lgSteps"><li class="on" data-i18n="vs.step.engage">Device engagement</li><li data-i18n="vs.step.approve">Approve</li><li data-i18n="vs.step.done">Signed in</li></ol>
          <p class="muted" id="lgPersonHint" data-i18n="vs.person.hint">In your wallet open “Share in person”, then point its QR code at the camera.</p>
          <div class="camera"><video id="lgVideo" playsinline muted></video><div class="frame"></div></div>
          <canvas id="lgCanvas" class="hidden"></canvas>
          <p><span class="pill" id="lgPStatus" data-i18n="vs.person.looking">Looking for the wallet’s QR code…</span></p>
          <p class="muted" style="font-size:.85rem" data-i18n="vs.person.privacy">The request and your answer are end-to-end encrypted between the wallet and this site.</p>
        </div>
        <div id="lgErr" class="msg err hidden"></div>
        <p class="hidden" id="lgBackRow"><button class="btn secondary" id="lgBack" data-i18n="common.back">Back</button></p>
      </div></div></div>`;
  }

  async function start({ tenant, flow, titleKey, asks, render, onState }) {
    await App.init({ tenant, titleKey });
    document.body.insertAdjacentHTML('beforeend', modalHtml());
    App.applyI18n();
    let me = null, stopPoll = null, stream = null, scanning = false;

    const show = () => {
      document.querySelectorAll('[data-when=out]').forEach((e) => e.classList.toggle('hidden', !!me));
      document.querySelectorAll('[data-when=in]').forEach((e) => e.classList.toggle('hidden', !me));
      if (me) $('account').innerHTML = render(me, App.esc, App.t);
      if (onState) onState(me);
      window.scrollTo({ top: 0 });
    };
    const reset = () => {
      stopCamera(); if (stopPoll) stopPoll();
      $('lgChoose').classList.remove('hidden'); $('lgOnlinePane').classList.add('hidden'); $('lgPersonPane').classList.add('hidden'); $('lgBackRow').classList.add('hidden'); $('lgErr').classList.add('hidden');
    };
    const open = () => { reset(); $('lgModal').classList.add('open'); };
    const close = () => { reset(); $('lgModal').classList.remove('open'); };
    $('lgClose').onclick = close; $('lgModal').onclick = (e) => { if (e.target === $('lgModal')) close(); }; $('lgBack').onclick = reset;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.querySelectorAll('[data-signin]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
    document.querySelectorAll('[data-signout]').forEach((b) => b.addEventListener('click', async (e) => { e.preventDefault(); await App.api('/api/logout', { method: 'POST', body: {} }); me = null; show(); }));
    document.addEventListener('langchange', () => { if (me) show(); renderAsks(); });
    const renderAsks = () => { $('lgAsks').innerHTML = asks.map((k) => '<li>' + App.esc(App.t(k)) + '</li>').join(''); };
    renderAsks();

    const fail = (key, detail) => { $('lgErr').textContent = App.t(key) + (detail ? ' (' + detail + ')' : ''); $('lgErr').classList.remove('hidden'); $('lgBackRow').classList.remove('hidden'); };
    const signedIn = async () => { me = await App.api('/api/me?flow=' + flow); close(); show(); };
    const poll = (s, statusEl) => {
      stopPoll = App.poll(async () => {
        const r = await fetch('/api/sessions/' + s.id + '?token=' + encodeURIComponent(s.poll_token), { cache: 'no-store' });
        if (r.status === 404) { fail('v.expired'); return true; }
        const j = await r.json();
        if (j.status === 'verified') { await signedIn(); return true; }
        if (j.status === 'rejected') { fail('v.rejected', j.error); return true; }
        return false;
      }, 1200);
    };

    // ---- online (OpenID4VP)
    $('lgOnline').onclick = async () => {
      $('lgChoose').classList.add('hidden'); $('lgOnlinePane').classList.remove('hidden'); $('lgBackRow').classList.remove('hidden');
      try {
        const s = await App.api('/api/sessions', { method: 'POST', body: { flow } });
        $('lgQr').src = App.qrUrl(s.request_uri); $('lgDeep').href = s.request_uri;
        $('lgDeep').classList.toggle('hidden', !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && false);
        poll(s);
      } catch { fail('v.failed'); }
    };

    // ---- in person (ISO 18013-5 device engagement scanned by this device's camera)
    function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
    const setStep = (i) => document.querySelectorAll('#lgSteps li').forEach((li, k) => { li.className = k < i ? 'done' : k === i ? 'on' : ''; });
    $('lgPerson').onclick = async () => {
      $('lgChoose').classList.add('hidden'); $('lgPersonPane').classList.remove('hidden'); $('lgBackRow').classList.remove('hidden'); setStep(0);
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('camera');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        const v = $('lgVideo'); v.srcObject = stream; await v.play(); scanning = true;
        const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
        const canvas = $('lgCanvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (!scanning) return;
          let text = null;
          try {
            if (detector) { const f = await detector.detect(v); if (f.length) text = f[0].rawValue; }
            else if (v.videoWidth) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; ctx.drawImage(v, 0, 0); const img = ctx.getImageData(0, 0, canvas.width, canvas.height); const r = window.jsQR && jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); if (r) text = r.data; }
          } catch { /* keep scanning */ }
          if (text && /^mdoc:/i.test(text)) return engaged(text);
          if (text) { $('lgPStatus').textContent = App.t('vs.person.notWallet'); }
          setTimeout(tick, 180);
        };
        tick();
      } catch { stopCamera(); fail('vs.person.noCamera'); }
    };
    async function engaged(qr) {
      stopCamera(); setStep(1);
      $('lgPStatus').textContent = App.t('vs.person.waiting'); $('lgPStatus').className = 'pill ok'; $('lgPersonHint').classList.add('hidden');
      try { const s = await App.api('/api/proximity/start', { method: 'POST', body: { flow, engagement: qr } }); poll(s); }
      catch (e) { fail(e.code === 'unsupported_relay' ? 'vs.person.badRelay' : 'v.failed'); }
    }

    try { me = await App.api('/api/me?flow=' + flow); } catch { me = null; }
    show();
    return { open, close };
  }
  return { start };
})();
