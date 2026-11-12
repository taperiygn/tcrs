(function () {
  /* tap sound on every click (same tick as the builder app) — Web Audio,
     decoded once at first pointerdown, a buffer source per click.
     Volume follows the app's Settings panel (tcrs:prefs). */
  var tapVol = 0.4;
  try {
    var p = JSON.parse(localStorage.getItem('tcrs:prefs') || '{}');
    if (p.vol !== undefined) tapVol = Math.max(0, Math.min(1, p.vol / 100));
    if (p.hue !== undefined) document.documentElement.style.setProperty('--theme-h', String(p.hue));
    if (p.bri !== undefined) document.documentElement.style.setProperty('--theme-b', String(p.bri / 100));
  } catch (e) { }
  var tapCtx = null, tapBuf = null, tapLoading = false;
  function tapPlayBuf() {
    try {
      var src = tapCtx.createBufferSource();
      src.buffer = tapBuf;
      var g = tapCtx.createGain();
      g.gain.value = tapVol;
      src.connect(g); g.connect(tapCtx.destination);
      src.start();
    } catch (e) { console.warn('tap sound failed:', e && e.message); }
  }
  function tapPrepare() {
    try {
      if (!tapCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        tapCtx = new AC();
      }
      if (tapCtx.state === 'suspended') tapCtx.resume().catch(function () { });
      if (!tapBuf && !tapLoading) {
        tapLoading = true;
        fetch('tap.mp3')
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(function (ab) {
            tapCtx.decodeAudioData(ab, function (buf) { tapBuf = buf; },
              function (e) { tapLoading = false; console.warn('tap sound decode failed:', e && e.message); });
          })
          .catch(function (e) { tapLoading = false; console.warn('tap sound load failed:', e && e.message); });
      }
    } catch (e) { console.warn('tap sound init failed:', e && e.message); }
  }
  function playTap() {
    tapPrepare();
    if (tapCtx && tapBuf) tapPlayBuf();
  }
  document.addEventListener('pointerdown', tapPrepare, true);
  document.addEventListener('click', playTap, true);

  /* current public tunnel link (injected by the server when the tunnel is up) */
  var tunnel = window.__TCRS_TUNNEL;
  if (tunnel) {
    var host = document.querySelector('.login');
    var box = document.createElement('div');
    box.className = 'tunnel';
    box.innerHTML = '<div class="t-label">Public link · tap to copy</div>' +
      '<button type="button" class="t-url" id="t-url"></button>';
    host.appendChild(box);
    var btn = box.querySelector('.t-url');
    btn.textContent = tunnel;
    btn.addEventListener('click', function () {
      try { navigator.clipboard && navigator.clipboard.writeText(tunnel); } catch (e) { }
      btn.textContent = 'Copied ✓';
      setTimeout(function () { btn.textContent = tunnel; }, 1300);
    });
  }

  var form = document.getElementById('form');
  var msg = document.getElementById('msg');
  var go = document.getElementById('go');
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = '';
    go.disabled = true;
    try {
      var r = await fetch((window.TCRS_API_BASE || '') + '/api/login', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TCRS': '1' },
        body: JSON.stringify({ password: document.getElementById('pw').value })
      });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok) {
        if (d.token) { try { localStorage.setItem('tcrs:token', d.token); } catch (e) { } }
        location.replace('./');
        return;
      }
      msg.textContent = d.error || 'Could not sign in.';
    } catch (err) {
      msg.textContent = 'Could not reach the server.';
    }
    go.disabled = false;
    document.getElementById('pw').select();
  });
})();
