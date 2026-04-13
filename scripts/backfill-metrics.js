#!/usr/bin/env node
/**
 * Backfill historical agent metrics from statusHistory data.
 * Calls the server's computeDailyMetrics endpoint for each date.
 * 
 * Usage: node scripts/backfill-metrics.js
 * Requires the Org Studio server to be running on localhost:4501
 */

const PORT = process.env.PORT || 4501;
const API_KEY = process.env.ORG_STUDIO_API_KEY || '';
const BASE = `http://127.0.0.1:${PORT}`;

async function backfill() {
  // 1. Fetch all tasks to find the date range
  console.log('Fetching store data...');
  const storeRes = await fetch(`${BASE}/api/store`);
  if (!storeRes.ok) {
    console.error('Failed to fetch store:', storeRes.status);
    process.exit(1);
  }
  const store = await storeRes.json();
  
  // 2. Find all unique dates from statusHistory
  const dates = new Set();
  for (const task of (store.tasks || [])) {
    for (const h of (task.statusHistory || [])) {
      if (h.timestamp && h.timestamp > 0) {
        const date = new Date(h.timestamp).toISOString().split('T')[0];
        dates.add(date);
      }
    }
    for (const c of (task.comments || [])) {
      if (c.createdAt && c.createdAt > 0) {
        const date = new Date(c.createdAt).toISOString().split('T')[0];
        dates.add(date);
      }
    }
  }
  
  const sortedDates = [...dates].sort();
  console.log(`Found ${sortedDates.length} unique dates (${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]})`);
  
  // 3. Check which dates already have metrics
  const metricsRes = await fetch(`${BASE}/api/metrics/team`);
  const existing = metricsRes.ok ? await metricsRes.json() : { metrics: [] };
  console.log(`Existing metrics: ${existing.metrics.length} agent summaries`);
  
  // 4. Trigger computation for each date via the internal endpoint
  // We need to call the server's computeDailyMetrics function.
  // Since it's in server.mjs, we can't call it directly from a script.
  // Instead, add a backfill API endpoint.
  
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  
  let computed = 0;
  for (const date of sortedDates) {
    try {
      const res = await fetch(`${BASE}/api/admin/backfill-metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ date }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.agents > 0) {
          console.log(`  ${date}: ${data.agents} agent(s) computed`);
          computed++;
        }
      } else {
        console.warn(`  ${date}: HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`  ${date}: ${e.message}`);
    }
  }
  
  console.log(`\nBackfill complete: ${computed} days with data out of ${sortedDates.length} total`);
}

backfill().catch(e => {
  console.error('Backfill failed:', e.message);
  process.exit(1);
});
