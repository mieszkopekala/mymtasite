// netlify/functions/gtfs.js - Zero dependencies
 
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
 
// ── Protobuf helpers ──
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return { value: result, pos };
}
 
function readString(buf, pos, len) {
  return { value: Buffer.from(buf.buffer, buf.byteOffset + pos, len).toString('utf8'), pos: pos + len };
}
 
function skip(buf, pos, wireType) {
  if (wireType === 0) { const v = readVarint(buf, pos); return v.pos; }
  if (wireType === 1) return pos + 8;
  if (wireType === 2) { const l = readVarint(buf, pos); return l.pos + l.value; }
  if (wireType === 5) return pos + 4;
  return pos + 1;
}
 
// ── Parse GTFS-RT ──
function parseGtfsRt(buffer) {
  const buf = new Uint8Array(buffer);
  const results = []; // { routeId, stopId, time }
  let pos = 0;
 
  function parseTimeEvent(end) {
    let time = null;
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (f === 2 && w === 0) { const v = readVarint(buf, pos); pos = v.pos; time = v.value; }
      else pos = skip(buf, pos, w);
    }
    pos = end; return time;
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
      } else pos = skip(buf, pos, w);
    }
    pos = end;
    return { stopId, time: arrival || departure };
  }
 
  function parseTripUpdate(end) {
    let routeId = null; const stus = [];
    while (pos < end) {
      const t = readVarint(buf, pos); pos = t.pos;
      const f = t.value >> 3, w = t.value & 7;
      if (w === 2) {
        const l = readVarint(buf, pos); pos = l.pos;
        const mEnd = pos + l.value;
        if (f === 1) {
          // trip descriptor - find route_id (field 5)
          const tripEnd = mEnd;
          while (pos < tripEnd) {
            const tt = readVarint(buf, pos); pos = tt.pos;
            const tf = tt.value >> 3, tw = tt.value & 7;
            if (tw === 2) {
              const tl = readVarint(buf, pos); pos = tl.pos;
              const tEnd = pos + tl.value;
              if (tf === 5) { const s = readString(buf, pos, tl.value); pos = s.pos; routeId = s.value; }
              else pos = tEnd;
            } else pos = skip(buf, pos, tw);
          }
          pos = tripEnd;
        }
        else if (f === 2) { stus.push(parseStopTimeUpdate(mEnd)); }
        else pos = mEnd;
      } else pos = skip(buf, pos, w);
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
      } else pos = skip(buf, pos, w);
    }
    pos = end;
    if (tu) {
      for (const stu of tu.stus) {
        results.push({ routeId: tu.routeId, stopId: stu.stopId, time: stu.time });
      }
    }
  }
 
  while (pos < buf.length) {
    const t = readVarint(buf, pos); pos = t.pos;
    const f = t.value >> 3, w = t.value & 7;
    if (w === 2) {
      const l = readVarint(buf, pos); pos = l.pos;
      const mEnd = pos + l.value;
      if (f === 2) { parseEntity(mEnd); }
      else pos = mEnd;
    } else pos = skip(buf, pos, w);
  }
 
  return results;
}
 
exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const { line, stop, debug } = event.queryStringParameters || {};
 
  if (!line || !stop) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing line or stop' }) };
 
  const feedPath = FEED_URLS[line];
  if (!feedPath) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown line: ${line}` }) };
 
  try {
    const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/${feedPath}`;
    const response = await fetch(url);
    if (!response.ok) return { statusCode: response.status, headers, body: JSON.stringify({ error: `MTA returned ${response.status}`, url }) };
 
    const buffer = await response.arrayBuffer();
    const allEntries = parseGtfsRt(buffer);
    const now = Math.floor(Date.now() / 1000);
    const direction = stop.endsWith('N') ? 'N' : 'S';
 
    // DEBUG MODE — shows sample stop IDs from the feed so we can verify format
    if (debug === 'true') {
      const sampleStops = [...new Set(allEntries.map(e => e.stopId).filter(Boolean))].slice(0, 50);
      const sampleRoutes = [...new Set(allEntries.map(e => e.routeId).filter(Boolean))];
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          totalEntries: allEntries.length,
          sampleStopIds: sampleStops,
          routeIds: sampleRoutes,
          requestedStop: stop,
          requestedLine: line,
          feedUrl: url,
        })
      };
    }
 
    const arrivals = [];
    for (const entry of allEntries) {
      if (entry.stopId !== stop) continue;
      if (!entry.time) continue;
      const diffSec = entry.time - now;
      if (diffSec < -30 || diffSec > 3600) continue;
      arrivals.push({
        mins: Math.max(0, Math.round(diffSec / 60)),
        dest: TERMINALS[direction]?.[entry.routeId || line] || (direction === 'N' ? 'Uptown' : 'Downtown'),
        express: ['4','5','A','D','B','N','Q'].includes(entry.routeId),
        routeId: entry.routeId || line,
      });
    }
 
    arrivals.sort((a, b) => a.mins - b.mins);
    return { statusCode: 200, headers, body: JSON.stringify({ arrivals: arrivals.slice(0, 6), stop, line, direction, total: allEntries.length }) };
 
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};