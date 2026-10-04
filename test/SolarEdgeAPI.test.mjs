import assert from 'node:assert/strict';
import { test } from 'node:test';

import SolarEdgeAPI from '../lib/SolarEdgeAPI.mjs';

// A SolarEdgeAPI whose login is counted instead of sent.
function countingApi({ failFirst = false } = {}) {
  const api = new SolarEdgeAPI();
  api.logins = 0;
  api.login = async () => {
    api.logins += 1;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    if (failFirst && api.logins === 1) throw new Error('Invalid e-mail and/or password.');
    api.cookies = ['JSESSIONID=abc'];
  };
  return api;
}

const credentials = { username: 'someone@example.com', password: 'secret' };

test('devices needing a session at the same time share one login', async () => {
  const api = countingApi();
  await Promise.all([1, 2, 3, 4, 5].map(() => api.ensureLoggedIn(credentials)));
  assert.equal(api.logins, 1);
  assert.ok(api.isLoggedIn());

  // A live session needs no login at all.
  await api.ensureLoggedIn(credentials);
  assert.equal(api.logins, 1);
});

test('an expired session logs in once more, and a failed login is retried', async () => {
  const api = countingApi({ failFirst: true });

  const results = await Promise.allSettled([api.ensureLoggedIn(credentials), api.ensureLoggedIn(credentials)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(api.logins, 1);

  await api.ensureLoggedIn(credentials);
  assert.equal(api.logins, 2);

  // A 401 clears the cookies (see request()); the next caller logs in again.
  api.cookies = [];
  await api.ensureLoggedIn(credentials);
  assert.equal(api.logins, 3);
});
