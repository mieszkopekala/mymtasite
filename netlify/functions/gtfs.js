// netlify/functions/gtfs.js
// Proxies MTA GTFS-RT protobuf feed → returns JSON arrivals for a given stop
//
// Deploy this in your Netlify project at: netlify/functions/gtfs.js
// Required npm package: npm install gtfs-realtime-bindings
// Add to package.json dependencies: "gtfs-realtime-bindings": "^1.x"

const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

// MTA GTFS-RT endpoint map
const FEED_URLS = {
  '1': 'nyct%2Fgtfs',
  '2': 'nyct%2Fgtfs',
  '3': 'nyct%2Fgtfs',
  '4': 'nyct%2Fgtfs',
  '5': 'nyct%2Fgtfs',
  '6': 'nyct%2Fgtfs',
  '7': 'nyct%2Fgtfs',
  'A': 'nyct%2Fgtfs-ace',
  'C': 'nyct%2Fgtfs-ace',
  'E': 'nyct%2Fgtfs-ace',
  'B': 'nyct%2Fgtfs-bdfm',
  'D': 'nyct%2Fgtfs-bdfm',
  'F': 'nyct%2Fgtfs-bdfm',
  'M': 'nyct%2Fgtfs-bdfm',
  'G': 'nyct%2Fgtfs-g',
  'J': 'nyct%2Fgtfs-jz',
  'Z': 'nyct%2Fgtfs-jz',
  'L': 'nyct%2Fgtfs-l',
  'N': 'nyct%2Fgtfs-nqrw',
  'Q': 'nyct%2Fgtfs-nqrw',
  'R': 'nyct%2Fgtfs-nqrw',
  'W': 'nyct%2Fgtfs-nqrw',
  'S': 'nyct%2Fgtfs-si',
  'SIR': 'nyct%2Fgtfs-si',
};

// Terminal names for destinations (simplified)
const TERMINALS = {
  'N': {
    '1': 'Van Cortlandt Park–242 St', '2': 'Wakefield–241 St', '3': '148 St–Lenox Terminal',
    '4': 'Woodlawn', '5': 'Eastchester–Dyre Ave', '6': 'Pelham Bay Park',
    '7': 'Flushing–Main St', 'A': 'Inwood–207 St or Far Rockaway',
    'C': 'Inwood–207 St', 'E': 'Jamaica Center', 'B': 'Bedford Park Blvd',
    'D': 'Norwood–205 St', 'F': 'Jamaica–179 St', 'M': 'Forest Hills–71 Ave',
    'G': 'Court Sq', 'J': 'Jamaica Center', 'Z': 'Jamaica Center',
    'L': '8 Ave', 'N': 'Astoria–Ditmars Blvd', 'Q': '96 St',
    'R': 'Forest Hills–71 Ave', 'W': 'Astoria–Ditmars Blvd',
    'S': 'Times Sq', 'SIR': 'St George',
  },
  'S': {
    '1': 'South Ferry', '2': 'Flatbush Ave–Brooklyn College', '3': 'New Lots Ave',
    '4': 'Crown Hts–Utica Ave or New Lots Ave', '5': 'Flatbush Ave–Brooklyn College',
    '6': 'Brooklyn Bridge–City Hall', '7': '34 St–Hudson Yards',
    'A': 'Far Rockaway or Rockaway Park or Ozone Park',
    'C': 'Euclid Ave', 'E': '8 Ave', 'B': 'Brighton Beach', 'D': 'Coney Island–Stillwell Ave',
    'F': 'Coney Island–Stillwell Ave', 'M': 'Middle Village–Metropolitan Ave',
    'G': 'Church Ave', 'J': 'Broad St', 'Z': 'Broad St',
    'L': 'Canarsie–Rockaway Pkwy', 'N': 'Coney Island–Stillwell Ave',
    'Q': 'Coney Island–Stillwell Ave', 'R': 'Bay Ridge–95 St', 'W': 'Whitehall St',
    'S': 'Grand Central', 'SIR': 'Tottenville',
  }
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const { line, stop } = event.queryStringParameters || {};
  if (!line || !stop) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing line or stop parameter' }) };
  }

  const feedPath = FEED_URLS[line];
  if (!feedPath) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown line: ${line}` }) };
  }

  try {
    const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/${feedPath}`;
    const response = await fetch(url);

    if (!response.ok) {
      return { statusCode: response.status, headers, body: JSON.stringify({ error: `MTA API returned ${response.status}` }) };
    }

    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const now = Math.floor(Date.now() / 1000);
    const arrivals = [];
    const direction = stop.endsWith('N') ? 'N' : 'S';

    feed.entity.forEach(entity => {
      if (!entity.tripUpdate) return;
      const { trip, stopTimeUpdate } = entity.tripUpdate;

      stopTimeUpdate.forEach(update => {
        if (update.stopId !== stop) return;

        const time = update.arrival?.time?.low || update.departure?.time?.low;
        if (!time) return;

        const diffSec = time - now;
        if (diffSec < -30 || diffSec > 3600) return; // ignore past and >1hr future

        const mins = Math.max(0, Math.round(diffSec / 60));
        const routeId = trip?.routeId || line;
        const isExpress = ['4','5','A','D','B','N','Q','J','Z'].includes(routeId);
        const dest = TERMINALS[direction]?.[routeId] || (direction === 'N' ? 'Uptown' : 'Downtown');

        arrivals.push({ mins, dest, express: isExpress, routeId, time });
      });
    });

    // Sort by arrival time and take top 6
    arrivals.sort((a, b) => a.mins - b.mins);
    const top6 = arrivals.slice(0, 6);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ arrivals: top6, stop, line, direction, generatedAt: now })
    };
  } catch (err) {
    console.error('GTFS error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
