#!/usr/bin/env node

/**
 * Strip redundant roadmap sections from vision docs.
 * 
 * For each vision doc in org_studio_vision_docs table:
 * 1. Check if the structured roadmap table has versions for that project
 * 2. If yes, remove the ## Roadmap section from the vision doc content
 * 3. Replace with a note directing to the Roadmap section below
 * 4. Update the vision doc in the database
 * 
 * Usage: node scripts/strip-vision-roadmaps.js
 */

const fs = require('fs');
const path = require('path');

// Load environment
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase environment variables');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
  },
});

async function stripVisionRoadmaps() {
  try {
    console.log('📖 Fetching vision docs...');
    
    // Fetch all vision docs
    const { data: visionDocs, error: docsError } = await supabase
      .from('org_studio_vision_docs')
      .select('id, project_id, content, updated_at');
    
    if (docsError) {
      throw new Error(`Failed to fetch vision docs: ${docsError.message}`);
    }
    
    if (!visionDocs || visionDocs.length === 0) {
      console.log('ℹ️  No vision docs found');
      return;
    }
    
    console.log(`Found ${visionDocs.length} vision docs`);
    
    // Fetch roadmap data to see which projects have structured roadmaps
    const { data: roadmapVersions, error: roadmapError } = await supabase
      .from('org_studio_roadmap_versions')
      .select('project_id');
    
    if (roadmapError) {
      throw new Error(`Failed to fetch roadmap versions: ${roadmapError.message}`);
    }
    
    const projectsWithRoadmaps = new Set((roadmapVersions || []).map(v => v.project_id));
    console.log(`Found ${projectsWithRoadmaps.size} projects with structured roadmaps\n`);
    
    let updated = 0;
    
    // Process each vision doc
    for (const doc of visionDocs) {
      // Check if this project has a structured roadmap
      if (!projectsWithRoadmaps.has(doc.project_id)) {
        console.log(`⏭️  Project ${doc.project_id}: No structured roadmap, skipping`);
        continue;
      }
      
      // Check if the doc has a Roadmap section
      const roadmapRegex = /## Roadmap[^\n]*\n([\s\S]*?)(?=## |\Z)/i;
      if (!roadmapRegex.test(doc.content)) {
        console.log(`⏭️  Project ${doc.project_id}: No Roadmap section found, skipping`);
        continue;
      }
      
      console.log(`🔧 Project ${doc.project_id}: Stripping Roadmap section...`);
      
      // Remove the Roadmap section and replace with note
      const newContent = doc.content
        .replace(
          /## Roadmap[^\n]*\n([\s\S]*?)(?=## |\Z)/i,
          '## Roadmap\n\n> Roadmap versions are managed in the Roadmap section below.\n'
        );
      
      // Update in database
      const { error: updateError } = await supabase
        .from('org_studio_vision_docs')
        .update({ content: newContent, updated_at: new Date().toISOString() })
        .eq('id', doc.id);
      
      if (updateError) {
        console.error(`❌ Failed to update doc ${doc.id}: ${updateError.message}`);
        continue;
      }
      
      console.log(`✅ Updated project ${doc.project_id}`);
      updated++;
    }
    
    console.log(`\n✨ Complete! Updated ${updated} vision docs.`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

stripVisionRoadmaps();
