#!/usr/bin/env node
/**
 * Unified HTTP Server for n8n-workflows
 * Supports both REST API and MCP Protocol
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs-extra';
import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// MCP imports
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import database - check if it exists first
let WorkflowDatabase;
try {
  // Try to import from current directory
  WorkflowDatabase = (await import('./database.js')).default;
} catch (e) {
  // If that fails, try CommonJS require (we'll create a wrapper)
  console.log('Creating database wrapper for CommonJS module...');
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  WorkflowDatabase = require('./database');
}

// Import MCP server - handle different possible locations
let N8NWorkflowsMCPServer;
try {
  // Check if index.js exists in parent directory
  const parentIndex = path.join(__dirname, '../index.js');
  if (fs.existsSync(parentIndex)) {
    const module = await import(parentIndex);
    N8NWorkflowsMCPServer = module.default || module.N8NWorkflowsMCPServer;
    console.log('✓ Loaded MCP server from ../index.js');
  } else {
    throw new Error('Not found in parent');
  }
} catch (e) {
  try {
    // Check current directory
    const currentIndex = path.join(__dirname, './index.js');
    if (fs.existsSync(currentIndex)) {
      const module = await import(currentIndex);
      N8NWorkflowsMCPServer = module.default || module.N8NWorkflowsMCPServer;
      console.log('✓ Loaded MCP server from ./index.js');
    } else {
      throw new Error('Not found in current');
    }
  } catch (e2) {
    console.warn('⚠️  N8NWorkflowsMCPServer not found, MCP endpoints will be disabled');
    console.warn('   Searched in:', path.join(__dirname, '../index.js'), 'and', path.join(__dirname, './index.js'));
    
    // Create a stub class so the server can still run
    N8NWorkflowsMCPServer = class {
      constructor() {
        this.server = {
          connect: async () => {},
          setRequestHandler: () => {}
        };
        this.db = null;
      }
    };
  }
}

// Initialize Express app
const app = express();
const db = new WorkflowDatabase();

// Store SSE sessions for MCP
const sseTransports = {};

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', apiLimiter);

// Rate limiting for MCP endpoints (more restrictive)
const mcpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 MCP requests per windowMs
  message: 'Too many MCP requests from this IP, please try again later.'
});
app.use('/mcp', mcpLimiter);
app.use('/sse', mcpLimiter);

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Large limit for workflow JSONs
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, '../static')));

// ==========================
// MCP Protocol Endpoints
// ==========================

// Helper to create MCP server instance
function createMCPServerInstance() {
  return new N8NWorkflowsMCPServer();
}

// Check if MCP is available
const isMCPAvailable = () => {
  try {
    const instance = new N8NWorkflowsMCPServer();
    return instance.server && typeof instance.server.connect === 'function';
  } catch (e) {
    return false;
  }
};

// Streamable HTTP endpoint for MCP
app.post('/mcp', async (req, res) => {
  if (!isMCPAvailable()) {
    return res.status(503).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'MCP service not available',
        data: 'MCP server implementation not found'
      }
    });
  }

  try {
    const serverInstance = createMCPServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    
    await serverInstance.server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Streamable HTTP error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message
        }
      });
    }
  }
});

// SSE endpoint for MCP (legacy)
app.get('/sse', async (req, res) => {
  if (!isMCPAvailable()) {
    return res.status(503).json({
      error: 'MCP service not available'
    });
  }

  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    const serverInstance = createMCPServerInstance();
    const transport = new SSEServerTransport('/messages', res);
    sseTransports[transport.sessionId] = { 
      transport, 
      server: serverInstance,
      createdAt: Date.now()
    };
    
    res.on('close', () => {
      delete sseTransports[transport.sessionId];
    });
    
    await serverInstance.server.connect(transport);
  } catch (error) {
    console.error('SSE error:', error);
    res.status(500).end();
  }
});

// SSE messages endpoint for MCP
app.post('/messages', async (req, res) => {
  if (!isMCPAvailable()) {
    return res.status(503).json({
      error: 'MCP service not available'
    });
  }

  const sessionId = req.query.sessionId;
  const session = sseTransports[sessionId];
  
  if (!session) {
    return res.status(400).json({ error: 'Invalid session' });
  }
  
  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error('Message handling error:', error);
    res.status(500).json({ error: 'Message processing failed' });
  }
});

// ==========================
// REST API Endpoints
// ==========================

// Health check endpoint (enhanced with MCP status)
app.get('/health', async (req, res) => {
  try {
    const stats = await db.getStats();
    const mcpAvailable = isMCPAvailable();
    
    res.json({ 
      status: 'healthy',
      message: 'N8N Workflow API is running',
      database: {
        connected: true,
        workflows: stats.total,
        active: stats.active
      },
      mcp: {
        enabled: mcpAvailable,
        transports: mcpAvailable ? ['streamable-http', 'sse'] : [],
        sseSessions: Object.keys(sseTransports).length
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Main page
app.get('/', (req, res) => {
  const staticPath = path.join(__dirname, '../static/index.html');
  
  if (fs.existsSync(staticPath)) {
    res.sendFile(staticPath);
  } else {
    // If no static files, return API information
    res.json({
      service: 'n8n-workflows',
      version: '1.0.0',
      endpoints: {
        rest: {
          stats: '/api/stats',
          workflows: '/api/workflows',
          integrations: '/api/integrations',
          categories: '/api/categories'
        },
        mcp: isMCPAvailable() ? {
          streamableHTTP: '/mcp (POST)',
          sse: '/sse (GET)', 
          sseMessages: '/messages (POST)'
        } : {
          status: 'MCP not available'
        },
        health: '/health (GET)'
      },
      capabilities: {
        workflows: 2053,
        integrations: 365,
        searchCategories: 12
      }
    });
  }
});

// Get workflow statistics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Error fetching stats', details: error.message });
  }
});

// Search workflows
app.get('/api/workflows', async (req, res) => {
  try {
    const {
      q = '',
      trigger = 'all',
      complexity = 'all',
      active_only = false,
      page = 1,
      per_page = 20
    } = req.query;
    
    const pageNum = Math.max(1, parseInt(page));
    const perPage = Math.min(100, Math.max(1, parseInt(per_page)));
    const offset = (pageNum - 1) * perPage;
    const activeOnly = active_only === 'true';
    
    const { workflows, total } = await db.searchWorkflows(
      q, trigger, complexity, activeOnly, perPage, offset
    );
    
    const pages = Math.ceil(total / perPage);
    
    res.json({
      workflows,
      total,
      page: pageNum,
      per_page: perPage,
      pages,
      query: q,
      filters: {
        trigger,
        complexity,
        active_only: activeOnly
      }
    });
  } catch (error) {
    console.error('Error searching workflows:', error);
    res.status(500).json({ error: 'Error searching workflows', details: error.message });
  }
});

// Get workflow detail
app.get('/api/workflows/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const workflow = await db.getWorkflowDetail(filename);
    
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    
    res.json(workflow);
  } catch (error) {
    console.error('Error fetching workflow detail:', error);
    res.status(500).json({ error: 'Error fetching workflow detail', details: error.message });
  }
});

// Download workflow
app.get('/api/workflows/:filename/download', async (req, res) => {
  try {
    const { filename } = req.params;
    const workflowPath = path.join(__dirname, '../workflows', filename);
    
    if (!fs.existsSync(workflowPath)) {
      return res.status(404).json({ error: 'Workflow file not found' });
    }
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(path.resolve(workflowPath));
  } catch (error) {
    console.error('Error downloading workflow:', error);
    res.status(500).json({ error: 'Error downloading workflow', details: error.message });
  }
});

// Get workflow diagram (Mermaid)
app.get('/api/workflows/:filename/diagram', async (req, res) => {
  try {
    const { filename } = req.params;
    const workflow = await db.getWorkflowDetail(filename);
    
    if (!workflow || !workflow.raw_workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    
    const diagram = generateMermaidDiagram(workflow.raw_workflow.nodes, workflow.raw_workflow.connections);
    res.json({ diagram });
  } catch (error) {
    console.error('Error generating diagram:', error);
    res.status(500).json({ error: 'Error generating diagram', details: error.message });
  }
});

// Generate Mermaid diagram
function generateMermaidDiagram(nodes, connections) {
  if (!nodes || nodes.length === 0) {
    return 'graph TD\n    A[No nodes found]';
  }
  
  let diagram = 'graph TD\n';
  
  // Add nodes
  nodes.forEach(node => {
    const nodeId = sanitizeNodeId(node.name);
    const nodeType = node.type?.split('.').pop() || 'unknown';
    diagram += `    ${nodeId}["${node.name}\\n(${nodeType})"]\n`;
  });
  
  // Add connections
  if (connections) {
    Object.entries(connections).forEach(([sourceNode, outputs]) => {
      const sourceId = sanitizeNodeId(sourceNode);
      
      outputs.main?.forEach(outputConnections => {
        outputConnections.forEach(connection => {
          const targetId = sanitizeNodeId(connection.node);
          diagram += `    ${sourceId} --> ${targetId}\n`;
        });
      });
    });
  }
  
  return diagram;
}

function sanitizeNodeId(nodeName) {
  // Convert node name to valid Mermaid ID
  return nodeName.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');
}

// Reindex workflows
app.post('/api/reindex', async (req, res) => {
  try {
    const { force = false } = req.body;
    
    // Run indexing in background
    db.indexWorkflows(force).then(results => {
      console.log('Indexing completed:', results);
    }).catch(error => {
      console.error('Indexing error:', error);
    });
    
    res.json({ message: 'Indexing started in background' });
  } catch (error) {
    console.error('Error starting reindex:', error);
    res.status(500).json({ error: 'Error starting reindex', details: error.message });
  }
});

// Get integrations
app.get('/api/integrations', async (req, res) => {
  try {
    const { workflows } = await db.searchWorkflows('', 'all', 'all', false, 1000, 0);
    
    const integrations = new Set();
    workflows.forEach(workflow => {
      workflow.integrations.forEach(integration => integrations.add(integration));
    });
    
    res.json(Array.from(integrations).sort());
  } catch (error) {
    console.error('Error fetching integrations:', error);
    res.status(500).json({ error: 'Error fetching integrations', details: error.message });
  }
});

// Get categories (based on integrations)
app.get('/api/categories', async (req, res) => {
  try {
    const { workflows } = await db.searchWorkflows('', 'all', 'all', false, 1000, 0);
    
    const categories = {
      'Communication': ['Slack', 'Discord', 'Telegram', 'Mattermost', 'Teams'],
      'CRM': ['HubSpot', 'Salesforce', 'Pipedrive', 'Copper'],
      'Data': ['GoogleSheets', 'Airtable', 'Mysql', 'Postgres'],
      'Development': ['GitHub', 'GitLab', 'Jira', 'Trello'],
      'Marketing': ['Mailchimp', 'Sendinblue', 'Typeform', 'Webflow'],
      'Storage': ['GoogleDrive', 'Dropbox', 'OneDrive', 'AWS S3'],
      'Other': []
    };
    
    // Categorize workflows
    const categorizedWorkflows = {};
    Object.keys(categories).forEach(category => {
      categorizedWorkflows[category] = [];
    });
    
    workflows.forEach(workflow => {
      let categorized = false;
      
      // Check each integration against categories
      workflow.integrations.forEach(integration => {
        Object.entries(categories).forEach(([category, services]) => {
          if (services.some(service => 
            integration.toLowerCase().includes(service.toLowerCase())
          )) {
            categorizedWorkflows[category].push(workflow);
            categorized = true;
          }
        });
      });
      
      // If not categorized, add to Other
      if (!categorized) {
        categorizedWorkflows['Other'].push(workflow);
      }
    });
    
    res.json(categorizedWorkflows);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Error fetching categories', details: error.message });
  }
});

// Error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: process.env.NODE_ENV === 'development' ? error.message : undefined 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
function startServer(port = 8000, host = '127.0.0.1') {
  const server = app.listen(port, host, () => {
    console.log('🚀 N8N Workflow Documentation & MCP Server');
    console.log('=' .repeat(50));
    console.log(`🌐 Server running at http://${host}:${port}`);
    console.log();
    console.log('📡 REST API Endpoints:');
    console.log(`   📊 API Documentation: http://${host}:${port}/api/stats`);
    console.log(`   🔍 Workflow Search: http://${host}:${port}/api/workflows`);
    console.log(`   📦 Integrations: http://${host}:${port}/api/integrations`);
    console.log(`   🏷️  Categories: http://${host}:${port}/api/categories`);
    
    if (isMCPAvailable()) {
      console.log();
      console.log('🤖 MCP Protocol Endpoints:');
      console.log(`   📮 Streamable HTTP: POST http://${host}:${port}/mcp`);
      console.log(`   📡 SSE (legacy): GET http://${host}:${port}/sse`);
      console.log(`   💬 SSE Messages: POST http://${host}:${port}/messages`);
    } else {
      console.log();
      console.log('⚠️  MCP Protocol: Not available (index.js not found)');
    }
    
    console.log();
    console.log('🏥 Health Check: http://${host}:${port}/health');
    console.log();
    console.log('Press Ctrl+C to stop the server');
    console.log('-'.repeat(50));
  });
  
  // Cleanup SSE sessions periodically
  setInterval(() => {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30 minutes
    
    Object.entries(sseTransports).forEach(([sessionId, session]) => {
      if (session.createdAt && (now - session.createdAt) > timeout) {
        console.log(`Cleaning up stale SSE session: ${sessionId}`);
        delete sseTransports[sessionId];
      }
    });
  }, 5 * 60 * 1000); // Check every 5 minutes
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down server...');
    
    // Close all SSE connections
    Object.values(sseTransports).forEach(session => {
      if (session.transport && session.transport.close) {
        session.transport.close();
      }
    });
    
    server.close(() => {
      db.close();
      console.log('✅ Server stopped');
      process.exit(0);
    });
  });
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  program
    .option('-p, --port <port>', 'Port to run server on', '8000')
    .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
    .option('--dev', 'Enable development mode')
    .parse();
  
  const options = program.opts();
  const port = parseInt(options.port);
  const host = options.host;
  
  // Set development mode
  if (options.dev) {
    process.env.NODE_ENV = 'development';
  }
  
  // Check if database needs initialization
  db.initialize().then(() => {
    return db.getStats();
  }).then(stats => {
    if (stats.total === 0) {
      console.log('⚠️  Warning: No workflows found. Run "npm run index" to index workflows.');
    } else {
      console.log(`✅ Database ready: ${stats.total} workflows indexed`);
    }
    startServer(port, host);
  }).catch(error => {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  });
}

export default app;