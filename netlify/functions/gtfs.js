// netlify/functions/gtfs.js
// Zero dependencies - parses protobuf manually
 
const FEED_URLS = {
  '1':'nyct%2Fgtfs','2':'nyct%2Fgtfs','3':'nyct%2Fgtfs',
  '4':'nyct%2Fgtfs','5':'nyct%2Fgtfs','6':'nyct%2Fgtfs','7':'nyct%2Fgtfs',
  'A':'nyct%2Fgtfs-ace','C':'nyct%2Fgtfs-ace','E':'nyct%2Fgtfs-ace',
  'B':'nyct%2Fgtfs-bdfm','D':'nyct%2Fgtfs-bdfm','F':'nyct%2Fgtfs-bdfm','M':'nyct%2Fgtfs-bdfm',
  'G':'nyct%2Fgtfs-g',
  'J':'nyct%2Fgtfs-jz','Z':'nyct%2Fgtfs-jz',
  'L':'nyct%2Fgtfs-l',
  'N':'nyct%2Fgtfs-nqrw','Q':'nyct%2Fgtfs-nqrw','R':'nyct%2Fgtfs-nqrw','W':'nyct%2Fgtfs-nqrw',
  'S':'nyct%2Fgtfs-si','SIR':'nyct%2Fgtfs-si',
};
 
const TERMINALS = {
  N:{
    '1':'Van Cortlandt Park–242 St','2':'Wakefield–241 St','3':'148 St–Lenox Terminal',
    '4':'Woodlawn','5':'Eastchester–Dyre Ave','6':'Pelham Bay Park','7':'Flushing–Main St',
    'A':'Inwood–207 St','C':'Inwood–207 St','E':'Jamaica Center',
    'B':'Bedford Park Blvd','D':'Norwood–205 St','F':'Jamaica–179 St','M':'Forest Hills–71 Ave',
    'G':'Court Sq','J':'Jamaica Center','Z':'Jamaica Center',
    'L':'8 Ave','N':'Astoria–Ditmars Blvd','Q':'96 St','R':'Forest Hills–71 Ave','W':'Astoria–Ditmars Blvd',
    'S':'Times Sq','SIR':'St George',
  },
  S:{
    '1':'South Ferry','2':'Flatbush Ave','3':'New Lots Ave',
    '4':'Crown Hts–Utica Ave','5':'Flatbush Ave','6':'Brooklyn Bridge','7':'34 St–Hudson Yards',
    'A':'Far Rockaway','C':'Euclid Ave','E':'8 Ave',
    'B':'Brighton Beach','D':'Coney Island','F':'Coney Island','M':'Middle Village',
    'G':'Church Ave','J':'Broad St','Z':'Broad St',
    'L':'Canarsie–Rockaway Pkwy','N':'Coney Island','Q':'Coney Island','R':'Bay Ridge–95 St','W':'Whitehall St',
    'S':'Grand Central','SIR':'Tottenville',
  }
};
 
function readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, pos };
}
 
function readString(buf, pos, len) {
  return { value: Buffer.from(buf.buffer, buf.byteOffset + pos, len).toString('utf8'), pos: pos + len };
}
 
function parseGtfsRt(buffer) {
  const buf = new Uint8Array(buffer);
  const arrivals_raw = [];
  let pos = 0;
 
  function skip(wireType) {
    if (wireType === 0) { const v = readVarint(buf, pos); pos = v.pos; }
    else if (wireType === 2) { const l = readVarint(buf, pos); pos = l.pos; pos += l.value; }
    else if (wireType === 5) { pos += 4; }
    else if (wireType === 1) { pos += 8; }
  }
 
  function parseTimeEvent(end) {
    let time = null;
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (f === 2 && w === 0) { const v = readVarint(buf, pos); pos = v.pos; time = v.value; }
      else skip(w);
    }
    pos = end;
    return time;
  }
 
  function parseStopTimeUpdate(end) {
    let stopId = null, arrival = null, departure = null;
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (w === 2) {
        const l = readVarint(buf, pos); pos = l.pos;
        const mEnd = pos + l.value;
        if (f === 3) { const s = readString(buf, pos, l.value); pos = s.pos; stopId = s.value; }
        else if (f === 4) { arrival = parseTimeEvent(mEnd); }
        else if (f === 5) { departure = parseTimeEvent(mEnd); }
        else pos = mEnd;
      } else skip(w);
    }
    pos = end;
    return { stopId, time: arrival || departure };
  }
 
  function parseTripDescriptor(end) {
    let routeId = null;
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (w === 2) {
        const l = readVarint(buf, pos); pos = l.pos;
        const mEnd = pos + l.value;
        if (f === 5) { const s = readString(buf, pos, l.value); pos = s.pos; routeId = s.value; }
        else pos = mEnd;
      } else skip(w);
    }
    pos = end;
    return routeId;
  }
 
  function parseTripUpdate(end) {
    let routeId = null;
    const stus = [];
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (w === 2) {
        const l = readVarint(buf, pos); pos = l.pos;
        const mEnd = pos + l.value;
        if (f === 1) { routeId = parseTripDescriptor(mEnd); }
        else if (f === 2) { stus.push(parseStopTimeUpdate(mEnd)); }
        else pos = mEnd;
      } else skip(w);
    }
    pos = end;
    return { routeId, stus };
  }
 
  function parseEntity(end) {
    let tu = null;
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (w === 2) {
        const l = readVarint(buf, pos); pos = l.pos;
        const mEnd = pos + l.value;
        if (f === 3) { tu = parseTripUpdate(mEnd); }
        else pos = mEnd;
      } else skip(w);
    }
    pos = end;
    if (tu) arrivals_raw.push(tu);
  }
 
  while (pos < buf.length) {
    const t = readVarint(buf, pos); pos = t.pos;
    const f = t.value >> 3, w = t.value & 7;
    if (w === 2) {
      const l = readVarint(buf, pos); pos = l.pos;
      const mEnd = pos + l.value;
      if (f === 2) { parseEntity(mEnd); }
      else pos = mEnd;
    } else skip(w);
  }
 
  return arrivals_raw;
}
 
exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const { line, stop } = event.queryStringParameters || {};
  if (!line || !stop) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing line or stop' }) };
 
  const feedPath = FEED_URLS[line];
  if (!feedPath) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown line: ${line}` }) };
 
  try {
    const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/${feedPath}`;
    const response = await fetch(url);
    if (!response.ok) return { statusCode: response.status, headers, body: JSON.stringify({ error: `MTA returned ${response.status}` }) };
 
    const buffer = await response.arrayBuffer();
    const entities = parseGtfsRt(buffer);
    const now = Math.floor(Date.now() / 1000);
    const direction = stop.endsWith('N') ? 'N' : 'S';
    const arrivals = [];
 
    for (const tu of entities) {
      for (const stu of tu.stus) {
        if (stu.stopId !== stop) continue;
        if (!stu.time) continue;
        const diffSec = stu.time - now;
        if (diffSec < -30 || diffSec > 3600) continue;
        arrivals.push({
          mins: Math.max(0, Math.round(diffSec / 60)),
          dest: TERMINALS[direction]?.[tu.routeId || line] || (direction === 'N' ? 'Uptown' : 'Downtown'),
          express: ['4','5','A','D','B','N','Q'].includes(tu.routeId),
          routeId: tu.routeId || line,
        });
      }
    }
 
    arrivals.sort((a, b) => a.mins - b.mins);
    return { statusCode: 200, headers, body: JSON.stringify({ arrivals: arrivals.slice(0, 6), stop, line, direction }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};