// netlify/functions/gtfs.js — zero dependencies
 
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
    'GS':'Times Sq','S':'Times Sq','SIR':'St George',
  },
  S:{
    '1':'South Ferry','2':'Flatbush Ave–Brooklyn College','3':'New Lots Ave',
    '4':'Crown Hts–Utica Ave','5':'Flatbush Ave–Brooklyn College','6':'Brooklyn Bridge–City Hall','7':'34 St–Hudson Yards',
    'A':'Far Rockaway','C':'Euclid Ave','E':'8 Ave',
    'B':'Brighton Beach','D':'Coney Island–Stillwell Ave','F':'Coney Island–Stillwell Ave','M':'Middle Village–Metropolitan Ave',
    'G':'Church Ave','J':'Broad St','Z':'Broad St',
    'L':'Canarsie–Rockaway Pkwy','N':'Coney Island–Stillwell Ave','Q':'Coney Island–Stillwell Ave',
    'R':'Bay Ridge–95 St','W':'Whitehall St–South Ferry',
    'GS':'Grand Central','S':'Grand Central','SIR':'Tottenville',
  }
};
 
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos >= buf.length) return { value: result, pos };
    b = buf[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value: result, pos };
}
 
// Read a length-prefixed string at pos, return {str, nextPos}
function readLenString(buf, pos) {
  const l = readVarint(buf, pos);
  const start = l.pos;
  const end = start + l.value;
  if (end > buf.length) return { str: null, nextPos: end };
  const str = Buffer.from(buf.buffer, buf.byteOffset + start, l.value).toString('utf8');
  return { str, nextPos: end };
}
 
// Scan the entire buffer for strings matching stop ID pattern (e.g. "101N", "A27S")
// and nearby varint timestamps, pairing them with the closest route ID string
function scanBuffer(buffer) {
  const buf = new Uint8Array(buffer);
  const results = [];
 
  // First pass: find all strings in the buffer
  // A length-delimited string field tag will be wireType=2
  // We scan every possible position for tag bytes that indicate string fields
 
  // Collect all (position, string) pairs for ASCII strings that look like stop IDs or route IDs
  const strings = []; // {pos, str}
 
  for (let i = 0; i < buf.length - 2; i++) {
    const byte = buf[i];
    // wiretype 2 (length-delimited), any field number 1-15 = 0x0a, 0x12, 0x1a, 0x22, 0x2a, 0x32, 0x3a, 0x42, 0x4a, 0x52, 0x5a, 0x62, 0x6a, 0x72, 0x7a
    if ((byte & 0x07) !== 2) continue;
 
    const lenV = readVarint(buf, i + 1);
    const strLen = lenV.value;
    if (strLen < 1 || strLen > 20) continue;
 
    const strStart = lenV.pos;
    const strEnd = strStart + strLen;
    if (strEnd > buf.length) continue;
 
    // Check if all bytes are printable ASCII
    let allAscii = true;
    for (let j = strStart; j < strEnd; j++) {
      if (buf[j] < 32 || buf[j] > 126) { allAscii = false; break; }
    }
    if (!allAscii) continue;
 
    const str = Buffer.from(buf.buffer, buf.byteOffset + strStart, strLen).toString('utf8');
    strings.push({ pos: i, end: strEnd, str });
  }
 
  // Now find stop ID / route ID / timestamp triples
  // In GTFS-RT, within a StopTimeUpdate:
  //   field 1 (stop_sequence): varint
  //   field 3 (stop_id): string  — tag = 0x1a
  //   field 4 (arrival): embedded msg with field 2 (time): varint — tag = 0x22, then inside tag 0x10
  //   field 5 (departure): embedded msg — tag = 0x2a
 
  // Strategy: find all stop_id strings (tag 0x1a = field 3, wiretype 2)
  // then look nearby for timestamps
 
  const stopIdTag = 0x1a; // field 3, wire type 2
  const routeIdTag = 0x2a; // field 5 in TripDescriptor, wire type 2
 
  // Find route IDs: they appear as field 5 (tag 0x2a) in TripDescriptor
  // which is field 1 (tag 0x0a) in TripUpdate, which is field 3 (tag 0x1a) in FeedEntity
  const routePositions = []; // {pos, routeId}
  for (const s of strings) {
    if (buf[s.pos] === routeIdTag && /^[A-Z0-9]{1,3}$/.test(s.str)) {
      routePositions.push({ pos: s.pos, routeId: s.str });
    }
  }
 
  // Find stop IDs: tag 0x1a, string matching stop ID pattern
  for (const s of strings) {
    if (buf[s.pos] !== stopIdTag) continue;
    if (!/^[A-Z0-9]{2,6}[NS]$/.test(s.str)) continue;
 
    // Find the most recent route ID before this position
    let routeId = null;
    for (let r = routePositions.length - 1; r >= 0; r--) {
      if (routePositions[r].pos < s.pos) {
        routeId = routePositions[r].routeId;
        break;
      }
    }
 
    // Look for arrival/departure time after this stop_id
    // arrival tag = 0x22 (field 4, wire 2), departure tag = 0x2a (field 5, wire 2)
    // Inside those, time is field 2 varint: tag 0x10
    let time = null;
    let scanPos = s.end;
    const scanLimit = Math.min(s.end + 30, buf.length);
 
    while (scanPos < scanLimit) {
      const t = buf[scanPos];
      if (t === 0x22 || t === 0x2a) {
        // arrival or departure message
        const innerLen = readVarint(buf, scanPos + 1);
        const innerStart = innerLen.pos;
        const innerEnd = innerStart + innerLen.value;
        // Look for time field (tag 0x10 = field 2, varint) inside
        let ip = innerStart;
        while (ip < innerEnd && ip < buf.length) {
          if (buf[ip] === 0x10) {
            // time varint
            const tv = readVarint(buf, ip + 1);
            if (tv.value > 1700000000 && tv.value < 2000000000) {
              time = tv.value;
              break;
            }
          }
          ip++;
        }
        if (time) break;
        scanPos = innerEnd;
      } else {
        scanPos++;
      }
    }
 
    results.push({ stopId: s.str, routeId, time });
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
    if (!response.ok) return { statusCode: response.status, headers, body: JSON.stringify({ error: `MTA returned ${response.status}` }) };
 
    const buffer = await response.arrayBuffer();
    const entries = scanBuffer(buffer);
    const now = Math.floor(Date.now() / 1000);
    const direction = stop.endsWith('N') ? 'N' : 'S';
 
    if (debug === 'true') {
      const uniqueStops = [...new Set(entries.map(e => e.stopId).filter(Boolean))].slice(0, 60);
      const uniqueRoutes = [...new Set(entries.map(e => e.routeId).filter(Boolean))];
      const sample = entries.filter(e => e.stopId && e.time).slice(0, 10);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          totalEntries: entries.length,
          withTime: entries.filter(e => e.time).length,
          sampleStopIds: uniqueStops,
          routeIds: uniqueRoutes,
          sampleWithTime: sample,
          requestedStop: stop,
        })
      };
    }
 
    const arrivals = [];
    for (const entry of entries) {
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
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ arrivals: arrivals.slice(0, 6), stop, line, direction, total: entries.length })
    };
 
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};