import * as dgram from 'dgram';
import * as http from 'http';

export interface RokuDevice {
  ip: string;
  name: string;
  model: string;
  serial: string;
  devMode: boolean;
}

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'ST: roku:ecp',
  'MX: 3',
  '',
  ''
].join('\r\n');

/**
 * Broadcast an SSDP M-SEARCH for Roku ECP endpoints and collect the IPs that answer.
 * Roku replies with a LOCATION header of the form http://<ip>:8060/, but the datagram
 * source address is just as reliable and avoids parsing a malformed header.
 */
function findAddresses(timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = () => {
      if (settled) { return; }
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found]);
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/roku:ecp/i.test(text) && !/Roku/i.test(text)) { return; }
      const location = /^LOCATION:\s*http:\/\/([0-9.]+)/im.exec(text);
      found.add(location ? location[1] : rinfo.address);
    });

    socket.on('error', finish);

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        // Some networks only forward multicast on a TTL above 1.
        socket.setMulticastTTL(4);
      } catch { /* non-fatal on restricted interfaces */ }

      const payload = Buffer.from(SEARCH, 'utf8');
      // Send a few times: UDP discovery packets are routinely dropped.
      const send = () => socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDR);
      send();
      const retry1 = setTimeout(send, 400);
      const retry2 = setTimeout(send, 1200);

      setTimeout(() => {
        clearTimeout(retry1);
        clearTimeout(retry2);
        finish();
      }, timeoutMs);
    });
  });
}

function get(url: string, timeoutMs = 2500): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/** Query a single IP's ECP device-info endpoint. Returns undefined if it isn't a Roku. */
export async function describe(ip: string): Promise<RokuDevice | undefined> {
  try {
    const xml = await get(`http://${ip}:8060/query/device-info`);
    if (!/<device-info>/i.test(xml)) { return undefined; }
    return {
      ip,
      name: tag(xml, 'user-device-name') || tag(xml, 'friendly-device-name') || tag(xml, 'model-name') || ip,
      model: tag(xml, 'model-name') || tag(xml, 'model-number'),
      serial: tag(xml, 'serial-number'),
      devMode: tag(xml, 'developer-enabled').toLowerCase() === 'true'
    };
  } catch {
    return undefined;
  }
}

/** Discover Rokus on the local network and enrich each with its device-info. */
export async function scan(timeoutMs: number): Promise<RokuDevice[]> {
  const addresses = await findAddresses(timeoutMs);
  const described = await Promise.all(addresses.map(describe));
  return described
    .filter((d): d is RokuDevice => !!d)
    .sort((a, b) => a.name.localeCompare(b.name));
}
