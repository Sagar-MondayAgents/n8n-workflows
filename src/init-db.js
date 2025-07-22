#!/usr/bin/env node

import fs from 'fs-extra';
import path from 'path';
import WorkflowDatabase from './database.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function initializeDatabase() {
  console.log('🔄 Initializing N8N Workflow Database...');
  console.log('📁 Working directory:', process.cwd());
  
  try {
    // Ensure required directories exist
    const dirs = ['database', 'workflows', 'static'];
    for (const dir of dirs) {
      const fullPath = path.join(process.cwd(), dir);
      await fs.ensureDir(fullPath);
      console.log(`✅ Directory ensured: ${fullPath}`);
    }
    
    // Initialize database
    const db = new WorkflowDatabase();
    console.log('🔧 Initializing database...');
    await db.initialize();
    
    // Get stats to verify database works
    const stats = await db.getStats();
    console.log('✅ Database initialized successfully');
    console.log(`📊 Current stats: ${stats.total} workflows`);
    
    db.close();
    
    console.log('\n🎉 Initialization complete!');
    console.log('Next steps:');
    console.log('1. Place your workflow JSON files in the "workflows" directory');
    console.log('2. Run "npm run index" to index your workflows');
    console.log('3. Run "npm start" to start the server');
    
  } catch (error) {
    console.error('❌ Initialization failed:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initializeDatabase();
} else {
  console.log('Script loaded but not executed directly');
}

export { initializeDatabase };