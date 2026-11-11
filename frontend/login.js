(function () {
  /* tap sound on every click (same tick as the builder app) */
  var tapAudio = null;
  document.addEventListener('click', function () {
    try {
      if (!tapAudio) tapAudio = new Audio('tap.mp3');
      var a = tapAudio.cloneNode();
      a.volume = 0.4;
      a.play().catch(function () { });
    } catch (e) { }
  }, true);

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
