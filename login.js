(function () {
  var form = document.getElementById('form');
  var msg = document.getElementById('msg');
  var go = document.getElementById('go');
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = '';
    go.disabled = true;
    try {
      var r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TCRS': '1' },
        body: JSON.stringify({ password: document.getElementById('pw').value })
      });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok) { location.replace('/'); return; }
      msg.textContent = d.error || 'Could not sign in.';
    } catch (err) {
      msg.textContent = 'Could not reach the server.';
    }
    go.disabled = false;
    document.getElementById('pw').select();
  });
})();
