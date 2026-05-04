// netlify/functions/gtfs.js
// Scans GTFS-RT protobuf for stop arrivals without full proto parsing
 
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
 
// Read varint from buffer at pos, return {value, pos}
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
 
// Read UTF-8 string from buffer
function readUtf8(buf, start, len) {
  try {
    return Buffer.from(buf.buffer, buf.byteOffset + start, len).toString('utf8');
  } catch {
    return '';
  }
}
 
// Check if a string looks like a valid GTFS stop ID (e.g. "101N", "A27S", "L03N")
function isValidStopId(s) {
  return /^[A-Z0-9]{2,6}[NS]$/.test(s);
}
 
// Check if a string looks like a valid route ID
function isValidRouteId(s) {
  return /^[A-Z0-9]{1,3}$/.test(s);
}
 
// Fully parse GTFS-RT protobuf
// We walk the wire format carefully, tracking nested message boundaries
function parseGtfsRt(buffer) {
  const buf = new Uint8Array(buffer);
  const results = []; // {routeId, stopId, time}
 
  function skip(pos, wireType) {
    if (wireType === 0) { const v = readVarint(buf, pos); return v.pos; }
    if (wireType === 1) return pos + 8;
    if (wireType === 2) { const l = readVarint(buf, pos); return l.pos + l.value; }
    if (wireType === 5) return pos + 4;
    return pos + 1;
  }
 
  // Parse a StopTimeEvent message (arrival or departure), return unix timestamp or null
  function parseStopTimeEvent(start, end) {
    let pos = start;
    let time = null;
    while (pos < end) {
      const tag = readVarint(buf, pos); pos = tag.pos;
      if (pos >= end) break;
      const fieldNum = tag.value >> 3;
      const wireType = tag.value & 7;
      if (fieldNum === 2 && wireType === 0) {
        // time field (sint64, zigzag encoded for negative, but timestamps are positive)
        const v = readVarint(buf, pos); pos = v.pos;
        time = v.value;
      } else {
        pos = skip(pos, wireType);
      }
    }
    return time;
  }
 
  // Parse a StopTimeUpdate message, return {stopId, time}
  function parseStopTimeUpdate(start, end) {
    let pos = start;
    let stopId = null;
    let arrivalTime = null;
    let departureTime = null;
 
    while (pos < end) {
      const tag = readVarint(buf, pos); pos = tag.pos;
      if (pos >= end) break;
      const fieldNum = tag.value >> 3;
      const wireType = tag.value & 7;
 
      if (wireType === 2) {
        const lenV = readVarint(buf, pos); pos = lenV.pos;
        const msgLen = lenV.value;
        const msgEnd = pos + msgLen;
 
        if (fieldNum === 3) {
          // stop_id is a string
          const s = readUtf8(buf, pos, msgLen);
          if (isValidStopId(s)) stopId = s;
          pos = msgEnd;
        } else if (fieldNum === 4) {
          // arrival StopTimeEvent
          arrivalTime = parseStopTimeEvent(pos, msgEnd);
          pos = msgEnd;
        } else if (fieldNum === 5) {
          // departure StopTimeEvent
          departureTime = parseStopTimeEvent(pos, msgEnd);
          pos = msgEnd;
        } else {
          pos = msgEnd;
        }
      } else if (wireType === 0) {
        const v = readVarint(buf, pos); pos = v.pos;
        // stop_sequence is field 1 (uint32), ignore
      } else {
        pos = skip(pos, wireType);
      }
    }
 
    return { stopId, time: arrivalTime || departureTime };
  }
 
  // Parse a TripDescriptor, return routeId
  function parseTripDescriptor(start, end) {
    let pos = start;
    let routeId = null;
    while (pos < end) {
      const tag = readVarint(buf, pos); pos = tag.pos;
      if (pos >= end) break;
      const fieldNum = tag.value >> 3;
      const wireType = tag.value & 7;
      if (wireType === 2) {
        const lenV = readVarint(buf, pos); pos = lenV.pos;
        const msgLen = lenV.value;
        const msgEnd = pos + msgLen;
        if (fieldNum === 5) {
          // route_id
          const s = readUtf8(buf, pos, msgLen);
          if (isValidRouteId(s)) routeId = s;
        }
        pos = msgEnd;
      } else if (wireType === 0) {
        pos = skip(pos, wireType);
      } else {
        pos = skip(pos, wireType);
      }
    }
    return routeId;
  }
 
  // Parse a TripUpdate message
  function parseTripUpdate(start, end) {
    let pos = start;
    let routeId = null;
    const stus = [];
 
    while (pos < end) {
      const tag = readVarint(buf, pos); pos = tag.pos;
      if (pos >= end) break;
      const fieldNum = tag.value >> 3;
      const wireType = tag.value & 7;
 
      if (wireType === 2) {
        const lenV = readVarint(buf, pos); pos = lenV.pos;
        const msgLen = lenV.value;
        const msgEnd = pos + msgLen;
 
        if (fieldNum === 1) {
          // trip (TripDescriptor)
          routeId = parseTripDescriptor(pos, msgEnd);
          pos = msgEnd;
        } else if (fieldNum === 2) {
          // stop_time_update
          const stu = parseStopTimeUpdate(pos, msgEnd);
          stus.push(stu);
          pos = msgEnd;
        } else {
          pos = msgEnd;
        }
      } else if (wireType === 0) {
        pos = skip(pos, wireType);
      } else {
        pos = skip(pos, wireType);
      }
    }
 
    return { routeId, stus };
  }
 
  // Parse a FeedEntity message
  function parseFeedEntity(start, end) {
    let pos = start;
    let tu = null;
 
    while (pos < end) {
      const tag = readVarint(buf, pos); pos = tag.pos;
      if (pos >= end) break;
      const fieldNum = tag.value >> 3;
      const wireType = tag.value & 7;
 
      if (wireType === 2) {
        const lenV = readVarint(buf, pos); pos = lenV.pos;
        const msgLen = lenV.value;
        const msgEnd = pos + msgLen;
 
        if (fieldNum === 3) {
          // trip_update
          tu = parseTripUpdate(pos, msgEnd);
          pos = msgEnd;
        } else {
          pos = msgEnd;
        }
      } else if (wireType === 0) {
        pos = skip(pos, wireType);
      } else {
        pos = skip(pos, wireType);
      }
    }
 
    if (tu) {
      for (const stu of tu.stus) {
        results.push({ routeId: tu.routeId, stopId: stu.stopId, time: stu.time });
      }
    }
  }
 
  // Parse top-level FeedMessage
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos); pos = tag.pos;
    if (pos >= buf.length) break;
    const fieldNum = tag.value >> 3;
    const wireType = tag.value & 7;
 
    if (wireType === 2) {
      const lenV = readVarint(buf, pos); pos = lenV.pos;
      const msgLen = lenV.value;
      const msgEnd = pos + msgLen;
 
      if (fieldNum === 1) {
        // header - skip
        pos = msgEnd;
      } else if (fieldNum === 2) {
        // entity
        parseFeedEntity(pos, msgEnd);
        pos = msgEnd;
      } else {
        pos = msgEnd;
      }
    } else if (wireType === 0) {
      pos = skip(pos, wireType);
    } else {
      pos = skip(pos, wireType);
    }
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
    const entries = parseGtfsRt(buffer);
    const now = Math.floor(Date.now() / 1000);
    const direction = stop.endsWith('N') ? 'N' : 'S';
 
    // Debug mode — show what stop IDs and routes we're actually parsing
    if (debug === 'true') {
      const validStops = entries.filter(e => e.stopId).map(e => e.stopId);
      const uniqueStops = [...new Set(validStops)].slice(0, 60);
      const uniqueRoutes = [...new Set(entries.map(e => e.routeId).filter(Boolean))];
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          totalEntries: entries.length,
          validStopCount: validStops.length,
          sampleStopIds: uniqueStops,
          routeIds: uniqueRoutes,
          requestedStop: stop,
          requestedLine: line,
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