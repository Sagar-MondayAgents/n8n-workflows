// src/database.js
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class WorkflowDatabase {
  constructor(dbPath = 'database/workflows.db') {
    this.dbPath = dbPath;
    this.workflowsDir = 'workflows';
    this.db = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await this.initDatabase();
    this.initialized = true;
  }

  async initDatabase() {
    // Ensure database directory exists
    const dbDir = path.dirname(this.dbPath);
    await fs.ensureDir(dbDir);

    // Open database synchronously with better-sqlite3
    this.db = new Database(this.dbPath);
    
    // Enable WAL mode for better performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('temp_store = MEMORY');
    
    this.createTables();
  }

  createTables() {
    // Main workflows table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        workflow_id TEXT,
        active BOOLEAN DEFAULT 0,
        description TEXT,
        trigger_type TEXT,
        complexity TEXT,
        node_count INTEGER DEFAULT 0,
        integrations TEXT,
        tags TEXT,
        created_at TEXT,
        updated_at TEXT,
        file_hash TEXT,
        file_size INTEGER,
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // FTS5 table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS workflows_fts USING fts5(
        filename,
        name,
        description,
        integrations,
        tags
      )
    `);
    
    // Indexes for performance
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_trigger_type ON workflows(trigger_type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_complexity ON workflows(complexity)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_active ON workflows(active)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_node_count ON workflows(node_count)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_filename ON workflows(filename)');
    
    // Triggers to sync FTS table
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS workflows_ai AFTER INSERT ON workflows BEGIN
        INSERT INTO workflows_fts(filename, name, description, integrations, tags)
        VALUES (new.filename, new.name, new.description, new.integrations, new.tags);
      END
    `);
    
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS workflows_ad AFTER DELETE ON workflows BEGIN
        DELETE FROM workflows_fts WHERE filename = old.filename;
      END
    `);
    
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS workflows_au AFTER UPDATE ON workflows BEGIN
        DELETE FROM workflows_fts WHERE filename = old.filename;
        INSERT INTO workflows_fts(filename, name, description, integrations, tags)
        VALUES (new.filename, new.name, new.description, new.integrations, new.tags);
      END
    `);
  }

  getFileHash(filePath) {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buffer).digest('hex');
  }

  formatWorkflowName(filename) {
    // Remove .json extension and split by underscores
    const name = filename.replace('.json', '');
    const parts = name.split('_');
    
    // Skip first part if it's just a number
    const startIndex = parts[0] && /^\d+$/.test(parts[0]) ? 1 : 0;
    const cleanParts = parts.slice(startIndex);
    
    return cleanParts.map(part => {
      const lower = part.toLowerCase();
      const specialTerms = {
        'http': 'HTTP',
        'api': 'API',
        'webhook': 'Webhook',
        'automation': 'Automation',
        'automate': 'Automate',
        'scheduled': 'Scheduled',
        'triggered': 'Triggered',
        'manual': 'Manual'
      };
      
      return specialTerms[lower] || part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
  }

  analyzeWorkflow(filePath) {
    try {
      const data = fs.readJsonSync(filePath);
      const filename = path.basename(filePath);
      const fileSize = fs.statSync(filePath).size;
      const fileHash = this.getFileHash(filePath);
      
      const workflow = {
        filename,
        name: this.formatWorkflowName(filename),
        workflow_id: data.id || '',
        active: data.active || false,
        nodes: data.nodes || [],
        connections: data.connections || {},
        tags: data.tags || [],
        created_at: data.createdAt || '',
        updated_at: data.updatedAt || '',
        file_hash: fileHash,
        file_size: fileSize
      };
      
      // Use meaningful JSON name if available
      const jsonName = data.name?.trim();
      if (jsonName && jsonName !== filename.replace('.json', '') && !jsonName.startsWith('My workflow')) {
        workflow.name = jsonName;
      }
      
      // Analyze nodes
      const nodeCount = workflow.nodes.length;
      workflow.node_count = nodeCount;
      
      // Determine complexity
      if (nodeCount <= 5) {
        workflow.complexity = 'low';
      } else if (nodeCount <= 15) {
        workflow.complexity = 'medium';
      } else {
        workflow.complexity = 'high';
      }
      
      // Analyze trigger type and integrations
      const { triggerType, integrations } = this.analyzeNodes(workflow.nodes);
      workflow.trigger_type = triggerType;
      workflow.integrations = Array.from(integrations);
      
      // Generate description
      workflow.description = this.generateDescription(workflow, triggerType, integrations);
      
      return workflow;
    } catch (error) {
      console.error(`Error analyzing workflow ${filePath}:`, error.message);
      return null;
    }
  }

  analyzeNodes(nodes) {
    const integrations = new Set();
    let triggerType = 'Manual';
    
    nodes.forEach(node => {
      const nodeType = node.type || '';
      
      // Extract integration name from node type
      if (nodeType.includes('.')) {
        const parts = nodeType.split('.');
        if (parts.length >= 2) {
          const integration = parts[1];
          if (integration !== 'core' && integration !== 'base') {
            integrations.add(integration.charAt(0).toUpperCase() + integration.slice(1));
          }
        }
      }
      
      // Determine trigger type based on node types
      if (nodeType.includes('webhook')) {
        triggerType = 'Webhook';
      } else if (nodeType.includes('cron') || nodeType.includes('schedule')) {
        triggerType = 'Scheduled';
      } else if (nodeType.includes('trigger')) {
        triggerType = 'Triggered';
      }
    });
    
    return { triggerType, integrations };
  }

  generateDescription(workflow, triggerType, integrations) {
    const parts = [];
    
    // Add trigger info
    if (triggerType !== 'Manual') {
      parts.push(`${triggerType} workflow`);
    } else {
      parts.push('Manual workflow');
    }
    
    // Add integration info
    if (integrations.size > 0) {
      const integrationList = Array.from(integrations).slice(0, 3);
      if (integrations.size > 3) {
        integrationList.push(`+${integrations.size - 3} more`);
      }
      parts.push(`integrating ${integrationList.join(', ')}`);
    }
    
    // Add complexity info
    parts.push(`with ${workflow.node_count} nodes (${workflow.complexity} complexity)`);
    
    return parts.join(' ');
  }

  async indexWorkflows(forceReindex = false) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const workflowFiles = await fs.readdir(this.workflowsDir);
    const jsonFiles = workflowFiles.filter(file => file.endsWith('.json'));
    
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const file of jsonFiles) {
      const filePath = path.join(this.workflowsDir, file);
      const workflow = this.analyzeWorkflow(filePath);
      
      if (!workflow) {
        errors++;
        continue;
      }
      
      try {
        // Check if workflow exists and if hash changed
        const existing = this.getWorkflowByFilename(file);
        if (!forceReindex && existing && existing.file_hash === workflow.file_hash) {
          skipped++;
          continue;
        }
        
        this.upsertWorkflow(workflow);
        processed++;
      } catch (error) {
        console.error(`Error indexing workflow ${file}:`, error.message);
        errors++;
      }
    }
    
    return { processed, skipped, errors, total: jsonFiles.length };
  }

  getWorkflowByFilename(filename) {
    return this.db.prepare('SELECT * FROM workflows WHERE filename = ?').get(filename);
  }

  upsertWorkflow(workflow) {
    const sql = `
      INSERT OR REPLACE INTO workflows (
        filename, name, workflow_id, active, description, trigger_type,
        complexity, node_count, integrations, tags, created_at, updated_at,
        file_hash, file_size, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    
    const stmt = this.db.prepare(sql);
    return stmt.run(
      workflow.filename,
      workflow.name,
      workflow.workflow_id,
      workflow.active ? 1 : 0,  // Convert boolean to integer
      workflow.description,
      workflow.trigger_type,
      workflow.complexity,
      workflow.node_count,
      JSON.stringify(workflow.integrations),
      JSON.stringify(workflow.tags),
      workflow.created_at,
      workflow.updated_at,
      workflow.file_hash,
      workflow.file_size
    );
  }

  buildFTSQuery(query) {
    // Escape FTS5 special characters and build partial matching query
    let cleanQuery = query
      .replace(/[^\w\s"'-]/g, ' ') // Remove special chars except quotes, hyphens, apostrophes
      .trim();
    
    if (!cleanQuery) return '*';
    
    // Handle quoted phrases
    const phrases = [];
    const quotedRegex = /"([^"]+)"/g;
    let match;
    
    while ((match = quotedRegex.exec(cleanQuery)) !== null) {
      phrases.push(`"${match[1]}"`); // Keep exact phrases
      cleanQuery = cleanQuery.replace(match[0], ' ');
    }
    
    // Split remaining terms and add wildcards for partial matching
    const terms = cleanQuery
      .split(/\s+/)
      .filter(term => term.length > 0)
      .map(term => {
        // Add wildcard suffix for prefix matching
        if (term.length >= 2) {
          return `${term}*`;
        }
        return term;
      });
    
    // Combine phrases and wildcard terms
    const allTerms = [...phrases, ...terms];
    
    if (allTerms.length === 0) return '*';
    
    // Join with AND for more precise results
    return allTerms.join(' AND ');
  }

  searchWorkflows(query = '', triggerFilter = 'all', complexityFilter = 'all', 
                 activeOnly = false, limit = 50, offset = 0) {
    if (!this.initialized) {
      throw new Error('Database not initialized');
    }
    
    let sql = '';
    let params = [];
    
    if (query.trim()) {
      // Use FTS search with partial matching
      const ftsQuery = this.buildFTSQuery(query.trim());
      sql = `
        SELECT w.* FROM workflows w
        JOIN workflows_fts fts ON w.filename = fts.filename
        WHERE workflows_fts MATCH ?
      `;
      params.push(ftsQuery);
    } else {
      // Regular search
      sql = 'SELECT * FROM workflows WHERE 1=1';
    }
    
    // Add filters
    if (triggerFilter !== 'all') {
      sql += ' AND trigger_type = ?';
      params.push(triggerFilter);
    }
    
    if (complexityFilter !== 'all') {
      sql += ' AND complexity = ?';
      params.push(complexityFilter);
    }
    
    if (activeOnly) {
      sql += ' AND active = 1';
    }
    
    // Get total count
    const countStmt = this.db.prepare(sql.replace(/SELECT \*/, 'SELECT COUNT(*) as total'));
    const { total } = countStmt.get(...params);
    
    // Add pagination
    sql += ' ORDER BY name LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    
    // Parse JSON fields
    const workflows = rows.map(row => ({
      ...row,
      integrations: JSON.parse(row.integrations || '[]'),
      tags: JSON.parse(row.tags || '[]')
    }));
    
    return { workflows, total };
  }

  async getStats() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const stats = {
      total: this.db.prepare('SELECT COUNT(*) as count FROM workflows').get().count,
      active: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE active = 1').get().count,
      inactive: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE active = 0').get().count,
      triggers: {},
      complexity: {},
      total_nodes: this.db.prepare('SELECT SUM(node_count) as sum FROM workflows').get().sum || 0,
      unique_integrations: 0,
      last_indexed: ''
    };
    
    // Get trigger distribution
    const triggers = this.db.prepare('SELECT trigger_type, COUNT(*) as count FROM workflows GROUP BY trigger_type').all();
    triggers.forEach(row => {
      stats.triggers[row.trigger_type] = row.count;
    });
    
    // Get complexity distribution
    const complexity = this.db.prepare('SELECT complexity, COUNT(*) as count FROM workflows GROUP BY complexity').all();
    complexity.forEach(row => {
      stats.complexity[row.complexity] = row.count;
    });
    
    // Count unique integrations
    const rows = this.db.prepare('SELECT integrations FROM workflows').all();
    const allIntegrations = new Set();
    rows.forEach(row => {
      try {
        const integrations = JSON.parse(row.integrations || '[]');
        integrations.forEach(integration => allIntegrations.add(integration));
      } catch (e) {
        // Ignore parse errors
      }
    });
    stats.unique_integrations = allIntegrations.size;
    
    // Get last indexed time
    const lastIndexed = this.db.prepare('SELECT analyzed_at FROM workflows ORDER BY analyzed_at DESC LIMIT 1').get();
    stats.last_indexed = lastIndexed?.analyzed_at || '';
    
    return stats;
  }

  getWorkflowDetail(filename) {
    const row = this.db.prepare('SELECT * FROM workflows WHERE filename = ?').get(filename);
    
    if (!row) return null;
    
    // Parse JSON fields and load raw workflow data
    const workflow = {
      ...row,
      integrations: JSON.parse(row.integrations || '[]'),
      tags: JSON.parse(row.tags || '[]')
    };
    
    // Load raw workflow JSON
    try {
      const workflowPath = path.join(this.workflowsDir, filename);
      const rawWorkflow = fs.readJsonSync(workflowPath);
      workflow.raw_workflow = rawWorkflow;
    } catch (error) {
      console.error(`Error loading raw workflow ${filename}:`, error.message);
    }
    
    return workflow;
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}