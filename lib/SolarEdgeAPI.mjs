import fetch from 'node-fetch';

export default class SolarEdgeAPI {

  cookies = '';

  isLoggedIn() {
    return this.cookies !== '';
  }

  async login({
    username,
    password,
  }) {
    const res = await fetch('https://monitoring.solaredge.com/solaredge-apigw/api/login', {
      method: 'POST',
      body: new URLSearchParams({
        j_username: username,
        j_password: password,
      }),
      redirect: 'manual',
    });

    if (res.status !== 302) {
      throw new Error('Error Signing In');
    }

    this.cookies = res.headers.raw()['set-cookie'].map(cookie => cookie.split(';')[0]);
  }

  async getSites() {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch('https://monitoring.solaredge.com/services/m/so/sites/', {
      headers: {
        Cookie: this.cookies.join('; '),
      },
    });

    if (!res.ok) {
      throw new Error('Error Getting Sites');
    }

    const { sites } = await res.json();
    return sites;
  }

  async getSite({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(`https://monitoring.solaredge.com/solaredge-apigw/api/v3/sites/${siteId}`, {
      headers: {
        Cookie: this.cookies.join('; '),
      },
    });

    if (!res.ok) {
      throw new Error('Error Getting Site');
    }

    const site = await res.json();
    return site;
  }

}