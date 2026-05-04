const { transit_realtime } = require('gtfs-realtime-bindings');
 
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
    const buffer = Buffer.from(arrayBuf);
 
    // Try to decode
    let feed;
    try {
      feed = transit_realtime.FeedMessage.decode(buffer);
    } catch(decodeErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ 
        error: 'Decode failed', 
        decodeError: decodeErr.message,
        bufferLength: buffer.length,
        firstBytes: buffer.slice(0, 20).toString('hex')
      })};
    }
 
    const now = Math.floor(Date.now() / 1000);
    const direction = stop.endsWith('N') ? 'N' : 'S';
    const entries = [];
 
    for (const entity of (feed.entity || [])) {
      const tu = entity.tripUpdate || entity.trip_update;
      if (!tu) continue;
      const routeId = (tu.trip && (tu.trip.routeId || tu.trip.route_id)) || line;
      const updates = tu.stopTimeUpdate || tu.stop_time_update || [];
      for (const stu of updates) {
        const stopId = stu.stopId || stu.stop_id;
        const arr = stu.arrival;
        const dep = stu.departure;
        const time = (arr && (arr.time || arr.time?.low || arr.time?.toNumber?.()))
                  || (dep && (dep.time || dep.time?.low || dep.time?.toNumber?.()))
                  || null;
        entries.push({ routeId, stopId, time });
      }
    }
 
    if (debug === 'true') {
      const uniqueStops = [...new Set(entries.map(e => e.stopId).filter(Boolean))].slice(0, 60);
      const uniqueRoutes = [...new Set(entries.map(e => e.routeId).filter(Boolean))];
      const sample = entries.filter(e => e.stopId && e.time).slice(0, 5);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          total: entries.length,
          withTime: entries.filter(e => e.time).length,
          sampleStopIds: uniqueStops,
          routeIds: uniqueRoutes,
          sampleWithTime: sample,
          entityCount: (feed.entity || []).length,
          requestedStop: stop,
        })
      };
    }
 
    const arrivals = [];
    for (const e of entries) {
      if (e.stopId !== stop || !e.time) continue;
      const diff = e.time - now;
      if (diff < -30 || diff > 3600) continue;
      arrivals.push({
        mins: Math.max(0, Math.round(diff / 60)),
        dest: TERMINALS[direction]?.[e.routeId] || (direction === 'N' ? 'Uptown' : 'Downtown'),
        express: ['4','5','A','D','B','N','Q'].includes(e.routeId),
        routeId: e.routeId,
      });
    }
 
    arrivals.sort((a, b) => a.mins - b.mins);
    return { statusCode: 200, headers, body: JSON.stringify({ arrivals: arrivals.slice(0, 6), stop, line, direction }) };
 
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};