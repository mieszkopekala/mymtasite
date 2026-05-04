// netlify/functions/gtfs.js
// Uses protobufjs loaded via eval from a CDN-hosted bundle
 
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
 
// Inline minimal protobuf reader
// Based on the actual GTFS-RT wire format spec
function decodeGtfsRt(bytes) {
  const results = [];
  let i = 0;
 
  function readVarInt() {
    let val = 0, shift = 0, b;
    do { b = bytes[i++]; val |= (b & 127) << shift; shift += 7; } while (b & 128);
    return val;
  }
 
  function skipField(wire) {
    if (wire === 0) readVarInt();
    else if (wire === 1) i += 8;
    else if (wire === 2) i += readVarInt();
    else if (wire === 5) i += 4;
  }
 
  function readStr(len) {
    const s = bytes.slice(i, i + len).toString('utf8');
    i += len;
    return s;
  }
 
  // Parse StopTimeEvent → return time (seconds epoch) or null
  function parseStopTimeEvent(end) {
    let time = null;
    while (i < end) {
      const tag = readVarInt();
      const field = tag >> 3, wire = tag & 7;
      if (field === 2 && wire === 0) time = readVarInt(); // time
      else skipField(wire);
    }
    i = end;
    return time;
  }
 
  // Parse StopTimeUpdate → return {stopId, time}
  function parseSTU(end) {
    let stopId = null, arrival = null, departure = null;
    while (i < end) {
      const tag = readVarInt();
      const field = tag >> 3, wire = tag & 7;
      if (wire === 2) {
        const len = readVarInt();
        const msgEnd = i + len;
        if (field === 3) { stopId = readStr(len); } // stop_id
        else if (field === 4) { arrival = parseStopTimeEvent(msgEnd); } // arrival
        else if (field === 5) { departure = parseStopTimeEvent(msgEnd); } // departure
        else i = msgEnd;
      } else if (wire === 0) {
        readVarInt(); // stop_sequence or schedule_relationship
      } else skipField(wire);
    }
    i = end;
    return { stopId, time: arrival || departure };
  }
 
  // Parse TripDescriptor → return routeId
  function parseTripDescriptor(end) {
    let routeId = null;
    while (i < end) {
      const tag = readVarInt();
      const field = tag >> 3, wire = tag & 7;
      if (wire === 2) {
        const len = readVarInt();
        const msgEnd = i + len;
        if (field === 5) { routeId = readStr(len); } // route_id
        else i = msgEnd;
      } else if (wire === 0) readVarInt();
      else skipField(wire);
    }
    i = end;
    return routeId;
  }
 
  // Parse TripUpdate → push to results
  function parseTripUpdate(end) {
    let routeId = null;
    const stus = [];
    while (i < end) {
      const tag = readVarInt();
      const field = tag >> 3, wire = tag & 7;
      if (wire === 2) {
        const len = readVarInt();
        const msgEnd = i + len;
        if (field === 1) { routeId = parseTripDescriptor(msgEnd); } // trip
        else if (field === 2) { stus.push(parseSTU(msgEnd)); } // stop_time_update
        else i = msgEnd;
      } else if (wire === 0) readVarInt();
      else skipField(wire);
    }
    i = end;
    for (const stu of stus) {
      results.push({ routeId, stopId: stu.stopId, time: stu.time });
    }
  }
 
  // Parse FeedEntity
  function parseFeedEntity(end) {
    while (i < end) {
      const tag = readVarInt();
      const field = tag >> 3, wire = tag & 7;
      if (wire === 2) {
        const len = readVarInt();
        const msgEnd = i + len;
        if (field === 3) { parseTripUpdate(msgEnd); } // trip_update
        else i = msgEnd;
      } else if (wire === 0) readVarInt();
      else skipField(wire);
    }
    i = end;
  }
 
  // Parse FeedMessage (top level)
  while (i < bytes.length) {
    const tag = readVarInt();
    const field = tag >> 3, wire = tag & 7;
    if (wire === 2) {
      const len = readVarInt();
      const msgEnd = i + len;
      if (field === 2) { parseFeedEntity(msgEnd); } // entity
      else i = msgEnd;
    } else if (wire === 0) readVarInt();
    else skipField(wire);
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
 
    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    const entries = decodeGtfsRt(bytes);
 
    const now = Math.floor(Date.now() / 1000);
    const direction = stop.endsWith('N') ? 'N' : 'S';
 
    if (debug === 'true') {
      const withStop = entries.filter(e => e.stopId);
      const uniqueStops = [...new Set(withStop.map(e => e.stopId))].slice(0, 60);
      const uniqueRoutes = [...new Set(entries.map(e => e.routeId).filter(Boolean))];
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          totalEntries: entries.length,
          withStop: withStop.length,
          withTime: entries.filter(e => e.time).length,
          sampleStopIds: uniqueStops,
          routeIds: uniqueRoutes,
          requestedStop: stop,
        })
      };
    }
 
    const arrivals = [];
    for (const e of entries) {
      if (e.stopId !== stop) continue;
      if (!e.time) continue;
      const diff = e.time - now;
      if (diff < -30 || diff > 3600) continue;
      arrivals.push({
        mins: Math.max(0, Math.round(diff / 60)),
        dest: TERMINALS[direction]?.[e.routeId || line] || (direction === 'N' ? 'Uptown' : 'Downtown'),
        express: ['4','5','A','D','B','N','Q'].includes(e.routeId),
        routeId: e.routeId || line,
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