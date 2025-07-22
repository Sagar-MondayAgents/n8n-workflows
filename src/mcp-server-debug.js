#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.error('MCP Server: Starting initialization...');
console.error('MCP Server: Current directory:', process.cwd());
console.error('MCP Server: __dirname:', __dirname);

class N8NWorkflowsMCPServer {
  constructor() {
    console.error('MCP Server: Creating server instance...');
    
    try {
      console.error('MCP Server: Creating MCP Server object...');
      this.server = new Server(
        {
          name: 'n8n-workflows-mcp',
          vendor: 'n8n-workflows',
          version: '1.0.0'
        },
        {
          capabilities: {
            tools: {}
          }
        }
      );
      console.error('MCP Server: Server object created successfully');

      // Configuration
      this.config = {
        dbPath: join(__dirname, '..', 'database', 'workflows.db'),
        workflowsDir: join(__dirname, '..', 'workflows'),
        categoriesPath: join(__dirname, '..', 'search_categories.json'),
        statsCache: null,
        statsCacheTime: 0,
        cacheTimeout: 5000 // 5 seconds cache
      };

      console.error('MCP Server: Configuration paths:');
      console.error(`- Database: ${this.config.dbPath}`);
      console.error(`- Workflows: ${this.config.workflowsDir}`);
      console.error(`- Categories: ${this.config.categoriesPath}`);

      console.error('MCP Server: Setting up database...');
      this.setupDatabase();
      console.error('MCP Server: Database setup complete');
      
      console.error('MCP Server: Setting up handlers...');
      this.setupHandlers();
      console.error('MCP Server: Handlers setup complete');
      
      console.error('MCP Server: Constructor complete');
    } catch (error) {
      console.error('MCP Server: Error during initialization:', error.message);
      console.error('Stack trace:', error.stack);
      throw error;
    }
  }

  setupDatabase() {
    console.error('MCP Server: Checking database existence...');
    console.error(`MCP Server: Looking for database at: ${this.config.dbPath}`);
    
    if (!existsSync(this.config.dbPath)) {
      console.error(`MCP Server: WARNING - Database not found at ${this.config.dbPath}`);
      console.error('MCP Server: Server will run with limited functionality');
      this.db = null;
      return;
    }
    
    try {
      console.error('MCP Server: Opening database connection...');
      this.db = new Database(this.config.dbPath, { readonly: false });
      console.error('MCP Server: Database opened successfully');
      
      console.error('MCP Server: Setting pragmas...');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      console.error('MCP Server: Pragmas set');
      
      // Test database connection
      console.error('MCP Server: Testing database connection...');
      const count = this.db.prepare('SELECT COUNT(*) as count FROM workflows').get();
      console.error(`MCP Server: Database connected successfully (${count.count} workflows)`);
    } catch (error) {
      console.error('MCP Server: Database connection failed:', error.message);
      console.error('Stack trace:', error.stack);
      this.db = null;
    }
  }

  setupHandlers() {
    console.error('MCP Server: Setting up request handlers...');
    
    // Handle list tools request
    console.error('MCP Server: Setting up ListTools handler...');
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.error('MCP Server: Handling ListTools request');
      return {
        tools: [
          {
            name: 'search_workflows',
            description: 'Search N8N workflows',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' }
              }
            }
          }
        ]
      };
    });
    
    console.error('MCP Server: ListTools handler set');
    
    // Handle tool calls
    console.error('MCP Server: Setting up CallTool handler...');
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`MCP Server: Handling CallTool request: ${name}`);
      
      if (name === 'search_workflows') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ message: 'Search functionality coming soon' })
          }]
        };
      }
      
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}`
      );
    });
    
    console.error('MCP Server: CallTool handler set');
    console.error('MCP Server: All handlers setup complete');
  }

  async run() {
    console.error('MCP Server: Starting server run method...');
    
    try {
      console.error('MCP Server: Creating StdioServerTransport...');
      const transport = new StdioServerTransport();
      console.error('MCP Server: Transport created');
      
      console.error('MCP Server: Connecting to transport...');
      await this.server.connect(transport);
      console.error('MCP Server: Connected to transport successfully');
      
      console.error('MCP Server: Server is ready and listening');
      
      // Keep the process alive
      process.stdin.resume();
      
      // Set up signal handlers
      process.on('SIGINT', async () => {
        console.error('MCP Server: Received SIGINT, shutting down...');
        if (this.db) {
          this.db.close();
        }
        process.exit(0);
      });
      
      process.on('SIGTERM', async () => {
        console.error('MCP Server: Received SIGTERM, shutting down...');
        if (this.db) {
          this.db.close();
        }
        process.exit(0);
      });
      
    } catch (error) {
      console.error('MCP Server: Fatal error during startup:', error.message);
      console.error('Stack trace:', error.stack);
      process.exit(1);
    }
  }
}

// Main execution
console.error('MCP Server: Checking if running as main...');
if (import.meta.url === `file://${process.argv[1]}` || 
    import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.error('MCP Server: Running as main script');
  const server = new N8NWorkflowsMCPServer();
  console.error('MCP Server: Server instance created, calling run()...');
  server.run().catch(error => {
    console.error('MCP Server: Fatal error:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  });
} else {
  console.error('MCP Server: Loaded as module');
}

export default N8NWorkflowsMCPServer;