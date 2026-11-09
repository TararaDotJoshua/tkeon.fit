// A stand-in for the TKE national module, for tests. Serves a login form, a
// landing page and a KRA page whose tables are drawn by JavaScript a moment
// after load. Modes add the awkward cases: a second login bounce, MFA, a
// CAPTCHA, and a rejected password.

import http from 'node:http';
import { readFileSync } from 'node:fs';

export const TEST_USER = 'mock-user';
export const TEST_PASS = 'mock-pass';

const data = JSON.parse(readFileSync(new URL('./fixtures/kras.json', import.meta.url), 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Each table draws its status dot differently, like a site that grew over time.
const dots = {
  kra: (met) => `<img src="/images/${met ? 'green' : 'red'}-dot.png" alt="" width="12" height="12">`,
  required: (met) => `<span class="dot" style="display:inline-block;width:12px;height:12px;border-radius:50%;background-color:${met ? '#2e7d32' : '#c62828'}"></span>`,
  bonus: (met) => `<i class="fa fa-circle" style="color:${met ? 'green' : 'red'}"></i>`,
};
const headings = { kra: 'Key Result Areas', required: 'Annually Required Items', bonus: 'Bonus' };

function table(section) {
  const rows = data[section];
  const sum = (i) => Math.round(rows.reduce((a, r) => a + r[i], 0) * 100) / 100;
  return `<table class="table table-bordered table-striped">
<thead><tr><th>KRA</th><th>Results</th><th>Goals</th><th>Points</th><th>Out Of</th><th></th></tr></thead>
<tbody>
${rows.map(([name, result, goal, pts, out, met]) => `<tr><td>${esc(name)}</td><td>${esc(result)}</td><td>${esc(goal)}</td><td>${pts}</td><td>${out}</td><td class="text-center">${dots[section](met)}</td></tr>`).join('\n')}
<tr class="total"><td><strong>Total</strong></td><td></td><td></td><td><strong>${sum(3)}</strong></td><td><strong>${sum(4)}</strong></td><td></td></tr>
</tbody></table>`;
}

export function kraTablesHtml() {
  return `<h2>${headings.kra}</h2>
${table('kra')}
<h2>${headings.required}</h2>
<div class="table-responsive">${table('required')}</div>
<div class="panel"><div class="panel-heading">${headings.bonus}</div><div class="panel-body">${table('bonus')}</div></div>`;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px Arial;margin:24px}.table{border-collapse:collapse;margin-bottom:24px}td,th{border:1px solid #ccc;padding:4px 8px}</style>
</head><body><nav>TKE Module · <a href="/Home">Home</a> · <a href="/Chapter/KRA">KRA</a></nav>${body}</body></html>`;

function loginForm(error = '', captcha = false) {
  return page('Log in', `<h1>Member log in</h1>${error ? `<p class="error">${error}</p>` : ''}
<form method="post" action="/Account/Login${''}">
<label>Username <input id="UserName" name="UserName" type="text"></label>
<label>Password <input id="Password" name="Password" type="password"></label>
${captcha ? '<iframe src="/recaptcha/api2/anchor?k=test" width="304" height="78"></iframe>' : ''}
<button type="submit">Log In</button></form>`);
}

/**
 * @param {{mode?: 'normal'|'bounce'|'mfa'|'captcha'|'badlogin'}} opts
 */
export function startMockTke({ mode = 'normal' } = {}) {
  const stats = { loginPosts: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie || '';
    const send = (status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
    const redirect = (to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };

    if (url.pathname === '/Account/Login' && req.method === 'GET') return send(200, loginForm('', mode === 'captcha'));
    if (url.pathname === '/Account/Login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        stats.loginPosts++;
        const f = new URLSearchParams(body);
        const good = f.get('UserName') === TEST_USER && f.get('Password') === TEST_PASS && mode !== 'badlogin';
        if (!good) return send(200, loginForm('Invalid username or password.'));
        if (mode === 'mfa') return redirect('/Account/Verify', { 'set-cookie': 'sess=mfa; Path=/' });
        // In bounce mode the first session is only half set up.
        const sess = mode === 'bounce' && !cookie.includes('sess=pre') ? 'pre' : 'ok';
        redirect('/Home', { 'set-cookie': `sess=${sess}; Path=/` });
      });
      return;
    }
    if (url.pathname === '/Account/Verify') {
      return send(200, page('Verify', '<h1>Check your email</h1><p>Enter the verification code we sent to your email.</p><input name="Code" autocomplete="one-time-code"><button>Verify</button>'));
    }
    if (url.pathname.startsWith('/recaptcha/')) return send(200, '<div style="width:300px;height:74px;border:1px solid #ccc">I\'m not a robot</div>');
    if (url.pathname === '/Home') return send(200, page('Home', '<h1>Welcome back</h1>'));
    if (url.pathname === '/Chapter/KRA') {
      if (!/sess=ok/.test(cookie)) return redirect(`/Account/Login?ReturnUrl=${encodeURIComponent('/Chapter/KRA')}`);
      const html = kraTablesHtml();
      return send(200, page('KRA', `<h1>Chapter KRAs</h1><div id="app">Loading…</div>
<script>setTimeout(() => { document.getElementById('app').innerHTML = ${JSON.stringify(html)}; }, 1200);</script>`));
    }
    if (url.pathname.startsWith('/images/')) {
      const color = url.pathname.includes('green') ? '#2e7d32' : '#c62828';
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="6" fill="${color}"/></svg>`);
    }
    send(404, page('Not found', 'Not found'));
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      base,
      stats,
      config: {
        loginUrl: `${base}/Account/Login`,
        kraUrl: `${base}/Chapter/KRA`,
        selectors: JSON.parse(readFileSync(new URL('../tke.config.json', import.meta.url), 'utf8')).selectors,
        waitForTableSeconds: 15,
      },
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}
