#!/usr/bin/env node
/**
 * Repair script: sync currentVersion for projects with shipped versions but null currentVersion
 * 
 * Root cause: v0.141-v0.15 were marked "shipped" without ever being "current",
 * so the roadmap sync (which only fires on status='current') never updated project.currentVersion
 * 
 * This script finds the most recent shipped version for each project and sets it as currentVersion.
 */

const port = process.env.PORT || 4501;
const apiKey = process.env.ORG_STUDIO_API_KEY || '';

const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

async function repairCurrentVersion() {
  console.log('[Repair] Fetching store data...');
  
  try {
    const storeRes = await fetch(`http://localhost:${port}/api/store`, { headers });
    if (!storeRes.ok) {
      console.error(`[Repair] Failed to fetch store: ${storeRes.status}`);
      process.exit(1);
    }
    
    const store = await storeRes.json();
    const { projects = [] } = store;
    
    // Find projects with null currentVersion but shipped versions
    const projectsNeedingRepair = projects.filter(p => 
      p.currentVersion === null && 
      p.versions && 
      p.versions.some(v => v.status === 'shipped')
    );
    
    if (projectsNeedingRepair.length === 0) {
      console.log('[Repair] No projects need repair. All currentVersions are set.');
      return;
    }
    
    console.log(`[Repair] Found ${projectsNeedingRepair.length} project(s) needing repair:`);
    
    // For each project, find the most recent shipped version
    for (const project of projectsNeedingRepair) {
      const shippedVersions = project.versions
        .filter(v => v.status === 'shipped')
        .sort((a, b) => {
          // Sort by sort_order DESC, then by version DESC (numeric comparison)
          const aOrder = a.sort_order !== undefined ? a.sort_order : parseFloat(a.version);
          const bOrder = b.sort_order !== undefined ? b.sort_order : parseFloat(b.version);
          return bOrder - aOrder;
        });
      
      if (shippedVersions.length === 0) {
        console.log(`  ⚠️ ${project.name}: No shipped versions found (unexpected)`);
        continue;
      }
      
      const mostRecentShipped = shippedVersions[0];
      console.log(`  📍 ${project.name} (${project.id})`);
      console.log(`     Most recent shipped: v${mostRecentShipped.version}`);
      console.log(`     Setting currentVersion to: v${mostRecentShipped.version}`);
      
      // Update project
      try {
        const updateRes = await fetch(`http://localhost:${port}/api/store`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'updateProject',
            id: project.id,
            updates: { currentVersion: mostRecentShipped.version },
          }),
        });
        
        if (updateRes.ok) {
          console.log(`     ✅ Updated successfully\n`);
        } else {
          console.error(`     ❌ Update failed: ${updateRes.status}`);
          console.error(`     Response:`, await updateRes.text());
        }
      } catch (e) {
        console.error(`     ❌ Update error:`, e.message);
      }
    }
    
    console.log('[Repair] Done.\n');
    
  } catch (e) {
    console.error('[Repair] Fatal error:', e.message);
    process.exit(1);
  }
}

repairCurrentVersion();
