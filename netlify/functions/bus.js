// netlify/functions/bus.js
// Proxies MTA BusTime API (SIRI) — keeps API key server-side

const API_KEY = process.env.BUS_API_KEY || '9709a4af-5fa9-415a-94fb-447ef335cb20';
const BASE = 'https://bustime.mta.info/api';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  const { action, route, stop, query, agency } = event.queryStringParameters || {};

  try {
    switch (action) {

      // Search stops by name/intersection
      case 'stop-search': {
        if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing query' }) };
        const data = await apiFetch(`${BASE}/where/search/stop.json?input=${encodeURIComponent(query)}&key=${API_KEY}`);
        const stops = (data.data?.list || []).slice(0, 12).map(s => ({
          id: s.id,
          code: s.code,
          name: s.name,
          direction: s.direction,
          routes: (s.routes || []).map(r => r.shortName || r.id),
          lat: s.lat,
          lon: s.lon,
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ stops }) };
      }

      // Get all stops for a route
      case 'route-stops': {
        if (!route) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing route' }) };
        const ag = agency || 'MTA+NYCT';
        const data = await apiFetch(`${BASE}/where/stops-for-route/${ag}_${route}.json?key=${API_KEY}&includePolylines=false`);
        
        const stopGroups = data.data?.stopGroupings?.[0]?.stopGroups || [];
        const directions = stopGroups.map(g => ({
          id: g.id,
          name: g.name?.name || g.name,
          stops: (g.stopIds || []).map(sid => {
            const stopRef = data.data?.references?.stops?.find(s => s.id === sid);
            return stopRef ? {
              id: stopRef.id,
              code: stopRef.code,
              name: stopRef.name,
              lat: stopRef.lat,
              lon: stopRef.lon,
            } : { id: sid, name: sid };
          })
        }));

        const routeRef = data.data?.references?.routes?.[0];
        const routeInfo = routeRef ? {
          id: routeRef.id,
          shortName: routeRef.shortName,
          longName: routeRef.longName,
          color: routeRef.color ? `#${routeRef.color}` : null,
          textColor: routeRef.textColor ? `#${routeRef.textColor}` : null,
          description: routeRef.description,
        } : { shortName: route };

        return { statusCode: 200, headers, body: JSON.stringify({ routeInfo, directions }) };
      }

      // Live arrivals at a stop
      case 'stop-arrivals': {
        if (!stop) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing stop' }) };
        const lineRef = route ? `&LineRef=MTA+NYCT_${route}` : '';
        const data = await apiFetch(
          `${BASE}/siri/stop-monitoring.json?key=${API_KEY}&MonitoringRef=${stop}&maximumStopVisits=8${lineRef}`
        );
        
        const visits = data?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
        const arrivals = visits.map(v => {
          const journey = v.MonitoredVehicleJourney;
          const call = journey?.MonitoredCall;
          const ext = call?.Extensions?.Distances;
          
          const expectedTime = call?.ExpectedArrivalTime || call?.AimedArrivalTime;
          const now = Date.now();
          let mins = null;
          if (expectedTime) {
            mins = Math.max(0, Math.round((new Date(expectedTime) - now) / 60000));
          }

          return {
            route: journey?.PublishedLineName?.[0] || journey?.LineRef?.replace('MTA NYCT_',''),
            destination: journey?.DestinationName?.[0] || 'Unknown',
            vehicleRef: journey?.VehicleRef,
            mins,
            stopsAway: ext?.StopsFromCall,
            distance: ext?.PresentableDistance,
            occupancy: journey?.Occupancy,
            aimed: call?.AimedArrivalTime,
            expected: call?.ExpectedArrivalTime,
          };
        }).filter(a => a.mins !== null && a.mins <= 90);

        return { statusCode: 200, headers, body: JSON.stringify({ arrivals, stop }) };
      }

      // Live vehicle positions for a route
      case 'route-vehicles': {
        if (!route) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing route' }) };
        const ag = agency || 'MTA NYCT';
        const data = await apiFetch(
          `${BASE}/siri/vehicle-monitoring.json?key=${API_KEY}&LineRef=${encodeURIComponent(ag)}_${route}`
        );
        
        const activity = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
        const vehicles = activity.map(v => {
          const journey = v.MonitoredVehicleJourney;
          return {
            vehicleRef: journey?.VehicleRef,
            lat: journey?.VehicleLocation?.Latitude,
            lon: journey?.VehicleLocation?.Longitude,
            bearing: journey?.Bearing,
            destination: journey?.DestinationName?.[0],
            nextStop: journey?.MonitoredCall?.StopPointName?.[0],
            stopsAway: journey?.MonitoredCall?.Extensions?.Distances?.StopsFromCall,
            occupancy: journey?.Occupancy,
          };
        });
        return { statusCode: 200, headers, body: JSON.stringify({ vehicles, route }) };
      }

      // Search routes by name
      case 'route-search': {
        if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing query' }) };
        const data = await apiFetch(`${BASE}/where/routes-for-agency/MTA+NYCT.json?key=${API_KEY}`);
        const q = query.toUpperCase().replace(/\s/g, '');
        const routes = (data.data?.list || [])
          .filter(r => r.shortName?.toUpperCase().includes(q) || r.longName?.toUpperCase().includes(q))
          .slice(0, 10)
          .map(r => ({
            id: r.id,
            shortName: r.shortName,
            longName: r.longName,
            color: r.color ? `#${r.color}` : null,
            description: r.description,
          }));
        return { statusCode: 200, headers, body: JSON.stringify({ routes }) };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};