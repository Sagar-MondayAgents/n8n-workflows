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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class N8NWorkflowsMCPServer {
  constructor() {
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

    // Configuration
    this.config = {
      dbPath: join(__dirname, '..', 'database', 'workflows.db'),
      workflowsDir: join(__dirname, '..', 'workflows'),
      categoriesPath: join(__dirname, '..', 'search_categories.json'),
      statsCache: null,
      statsCacheTime: 0,
      cacheTimeout: 5000 // 5 seconds cache
    };

    this.setupDatabase();
    this.setupHandlers();
  }

  setupDatabase() {
    // Initialize database connection
    if (existsSync(this.config.dbPath)) {
      this.db = new Database(this.config.dbPath, { readonly: false });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_workflows',
          description: 'Search N8N workflows with full-text search, filters, and categories. Supports 2,053 workflows with 365 unique integrations.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for full-text search across names, descriptions, and integrations'
              },
              category: {
                type: 'string',
                enum: ['messaging', 'ai_ml', 'database', 'email', 'cloud_storage', 'project_management', 
                        'social_media', 'ecommerce', 'analytics', 'calendar_tasks', 'forms', 'development'],
                description: 'Filter by service category'
              },
              trigger: {
                type: 'string',
                enum: ['Manual', 'Webhook', 'Scheduled', 'Complex'],
                description: 'Filter by trigger type'
              },
              complexity: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Filter by complexity (low: ≤5 nodes, medium: 6-15, high: 16+)'
              },
              active_only: {
                type: 'boolean',
                description: 'Filter only active workflows'
              },
              integrations: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by specific integrations (e.g., ["Telegram", "Slack"])'
              },
              limit: {
                type: 'integer',
                description: 'Number of results per page (1-100)',
                minimum: 1,
                maximum: 100,
                default: 20
              },
              offset: {
                type: 'integer',
                description: 'Offset for pagination',
                minimum: 0,
                default: 0
              },
              sort: {
                type: 'string',
                enum: ['name', 'node_count', 'analyzed_at'],
                description: 'Sort results by field'
              }
            }
          }
        },
        {
          name: 'get_workflow',
          description: 'Get detailed information about a specific N8N workflow including all nodes and connections',
          inputSchema: {
            type: 'object',
            properties: {
              filename: {
                type: 'string',
                description: 'Workflow filename (e.g., 2051_Telegram_Webhook_Automation_Webhook.json)'
              }
            },
            required: ['filename']
          }
        },
        {
          name: 'get_statistics',
          description: 'Get comprehensive workflow statistics including trigger distribution, complexity analysis, and integration usage',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_categories',
          description: 'Get all available workflow categories with counts and examples',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_integrations',
          description: 'Get list of all 365 unique integrations with usage statistics',
          inputSchema: {
            type: 'object',
            properties: {
              sort_by: {
                type: 'string',
                enum: ['count', 'name'],
                description: 'Sort integrations by usage count or name',
                default: 'count'
              }
            }
          }
        },
        {
          name: 'analyze_workflow',
          description: 'Analyze a workflow JSON to extract metadata, integrations, and generate insights',
          inputSchema: {
            type: 'object',
            properties: {
              workflow_json: {
                type: 'string',
                description: 'JSON content of the workflow to analyze'
              }
            },
            required: ['workflow_json']
          }
        },
        {
          name: 'generate_diagram',
          description: 'Generate a Mermaid diagram for workflow visualization',
          inputSchema: {
            type: 'object',
            properties: {
              filename: {
                type: 'string',
                description: 'Workflow filename to generate diagram for'
              }
            },
            required: ['filename']
          }
        },
        {
          name: 'export_workflow',
          description: 'Export a workflow with options for format and modifications',
          inputSchema: {
            type: 'object',
            properties: {
              filename: {
                type: 'string',
                description: 'Workflow filename to export'
              },
              remove_credentials: {
                type: 'boolean',
                description: 'Remove credential data from export',
                default: true
              },
              format: {
                type: 'string',
                enum: ['json', 'yaml'],
                description: 'Export format',
                default: 'json'
              }
            },
            required: ['filename']
          }
        },
        {
          name: 'bulk_analyze',
          description: 'Analyze multiple workflows to find patterns, common integrations, or similar workflows',
          inputSchema: {
            type: 'object',
            properties: {
              criteria: {
                type: 'object',
                properties: {
                  min_nodes: { type: 'integer' },
                  max_nodes: { type: 'integer' },
                  must_include_integrations: {
                    type: 'array',
                    items: { type: 'string' }
                  },
                  trigger_types: {
                    type: 'array',
                    items: { type: 'string' }
                  }
                },
                description: 'Criteria for selecting workflows to analyze'
              }
            }
          }
        },
        {
          name: 'find_similar',
          description: 'Find workflows similar to a given workflow based on integrations and structure',
          inputSchema: {
            type: 'object',
            properties: {
              filename: {
                type: 'string',
                description: 'Reference workflow filename'
              },
              similarity_threshold: {
                type: 'number',
                description: 'Minimum similarity score (0-1)',
                default: 0.7
              }
            },
            required: ['filename']
          }
        },
        {
          name: 'create_workflow_template',
          description: 'Create a new workflow template based on common patterns',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Name for the new workflow'
              },
              integrations: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of integrations to include'
              },
              trigger_type: {
                type: 'string',
                enum: ['Manual', 'Webhook', 'Scheduled'],
                description: 'Trigger type for the workflow'
              },
              description: {
                type: 'string',
                description: 'Description of what the workflow does'
              }
            },
            required: ['name', 'integrations', 'trigger_type']
          }
        },
        {
          name: 'validate_workflow',
          description: 'Validate a workflow JSON for correctness and compatibility',
          inputSchema: {
            type: 'object',
            properties: {
              workflow_json: {
                type: 'string',
                description: 'JSON content to validate'
              }
            },
            required: ['workflow_json']
          }
        },
        {
          name: 'get_workflow_recommendations',
          description: 'Get workflow recommendations based on use case or requirements',
          inputSchema: {
            type: 'object',
            properties: {
              use_case: {
                type: 'string',
                description: 'Describe your automation needs'
              },
              preferred_integrations: {
                type: 'array',
                items: { type: 'string' },
                description: 'Preferred services to use'
              }
            },
            required: ['use_case']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_workflows':
            return await this.searchWorkflows(args);
          case 'get_workflow':
            return await this.getWorkflow(args);
          case 'get_statistics':
            return await this.getStatistics();
          case 'get_categories':
            return await this.getCategories();
          case 'get_integrations':
            return await this.getIntegrations(args);
          case 'analyze_workflow':
            return await this.analyzeWorkflow(args);
          case 'generate_diagram':
            return await this.generateDiagram(args);
          case 'export_workflow':
            return await this.exportWorkflow(args);
          case 'bulk_analyze':
            return await this.bulkAnalyze(args);
          case 'find_similar':
            return await this.findSimilar(args);
          case 'create_workflow_template':
            return await this.createWorkflowTemplate(args);
          case 'validate_workflow':
            return await this.validateWorkflow(args);
          case 'get_workflow_recommendations':
            return await this.getWorkflowRecommendations(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${error.message}`
        );
      }
    });
  }

  async searchWorkflows(args) {
    const {
      query = '',
      category,
      trigger,
      complexity,
      active_only,
      integrations = [],
      limit = 20,
      offset = 0,
      sort = 'name'
    } = args;

    let sql = `
      SELECT w.*, 
        (SELECT COUNT(*) FROM workflows_fts WHERE workflows_fts MATCH ?) as rank
      FROM workflows w
      WHERE 1=1
    `;
    const params = [query || ''];

    // Add filters
    if (query) {
      sql += ` AND w.id IN (SELECT rowid FROM workflows_fts WHERE workflows_fts MATCH ?)`;
      params.push(query);
    }

    if (category) {
      // Load categories and filter
      const categories = this.loadCategories();
      const categoryWorkflows = categories[category] || [];
      if (categoryWorkflows.length > 0) {
        sql += ` AND w.filename IN (${categoryWorkflows.map(() => '?').join(',')})`;
        params.push(...categoryWorkflows);
      }
    }

    if (trigger) {
      sql += ` AND w.trigger_type = ?`;
      params.push(trigger);
    }

    if (complexity) {
      const complexityMap = {
        'low': [0, 5],
        'medium': [6, 15],
        'high': [16, 999]
      };
      const [min, max] = complexityMap[complexity];
      sql += ` AND w.node_count BETWEEN ? AND ?`;
      params.push(min, max);
    }

    if (active_only) {
      sql += ` AND w.active = 1`;
    }

    if (integrations.length > 0) {
      for (const integration of integrations) {
        sql += ` AND w.integrations LIKE ?`;
        params.push(`%"${integration}"%`);
      }
    }

    // Add sorting
    const sortMap = {
      'name': 'w.name',
      'node_count': 'w.node_count DESC',
      'analyzed_at': 'w.analyzed_at DESC'
    };
    sql += ` ORDER BY ${sortMap[sort] || 'w.name'}`;

    // Add pagination
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const workflows = this.db.prepare(sql).all(...params);

    // Get total count
    let countSql = sql.substring(0, sql.indexOf('ORDER BY'));
    countSql = `SELECT COUNT(*) as total FROM (${countSql})`;
    const countParams = params.slice(0, -2); // Remove limit and offset
    const { total } = this.db.prepare(countSql).get(...countParams);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total,
            page: Math.floor(offset / limit) + 1,
            pages: Math.ceil(total / limit),
            workflows: workflows.map(w => ({
              filename: w.filename,
              name: w.name,
              description: w.description,
              trigger_type: w.trigger_type,
              node_count: w.node_count,
              integrations: JSON.parse(w.integrations || '[]'),
              active: Boolean(w.active),
              complexity: this.getComplexityLevel(w.node_count)
            }))
          }, null, 2)
        }
      ]
    };
  }

  async getWorkflow(args) {
    const { filename } = args;
    
    // Get from database
    const workflow = this.db.prepare('SELECT * FROM workflows WHERE filename = ?').get(filename);
    
    if (!workflow) {
      throw new Error(`Workflow not found: ${filename}`);
    }

    // Load full JSON
    const filePath = join(this.config.workflowsDir, filename);
    const workflowJson = JSON.parse(readFileSync(filePath, 'utf8'));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            metadata: {
              filename: workflow.filename,
              name: workflow.name,
              description: workflow.description,
              trigger_type: workflow.trigger_type,
              node_count: workflow.node_count,
              integrations: JSON.parse(workflow.integrations || '[]'),
              active: Boolean(workflow.active),
              complexity: this.getComplexityLevel(workflow.node_count),
              analyzed_at: workflow.analyzed_at
            },
            workflow: workflowJson
          }, null, 2)
        }
      ]
    };
  }

  async getStatistics() {
    // Check cache
    if (this.statsCache && Date.now() - this.statsCacheTime < this.config.cacheTimeout) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(this.statsCache, null, 2)
          }
        ]
      };
    }

    const stats = {
      total: this.db.prepare('SELECT COUNT(*) as count FROM workflows').get().count,
      active: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE active = 1').get().count,
      inactive: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE active = 0').get().count,
      triggers: {},
      complexity: {},
      total_nodes: this.db.prepare('SELECT SUM(node_count) as sum FROM workflows').get().sum || 0,
      unique_integrations: 0,
      top_integrations: []
    };

    // Trigger distribution
    const triggers = this.db.prepare('SELECT trigger_type, COUNT(*) as count FROM workflows GROUP BY trigger_type').all();
    triggers.forEach(t => {
      stats.triggers[t.trigger_type] = t.count;
    });

    // Complexity distribution
    stats.complexity = {
      low: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE node_count <= 5').get().count,
      medium: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE node_count BETWEEN 6 AND 15').get().count,
      high: this.db.prepare('SELECT COUNT(*) as count FROM workflows WHERE node_count > 15').get().count
    };

    // Integration statistics
    const integrations = {};
    const rows = this.db.prepare('SELECT integrations FROM workflows').all();
    rows.forEach(row => {
      const ints = JSON.parse(row.integrations || '[]');
      ints.forEach(int => {
        integrations[int] = (integrations[int] || 0) + 1;
      });
    });

    stats.unique_integrations = Object.keys(integrations).length;
    stats.top_integrations = Object.entries(integrations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    // Average metrics
    stats.average_nodes_per_workflow = Math.round(stats.total_nodes / stats.total);
    stats.active_percentage = Math.round((stats.active / stats.total) * 100);

    // Cache results
    this.statsCache = stats;
    this.statsCacheTime = Date.now();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(stats, null, 2)
        }
      ]
    };
  }

  async getCategories() {
    const categories = this.loadCategories();
    const categoryStats = {};

    for (const [category, workflows] of Object.entries(categories)) {
      categoryStats[category] = {
        count: workflows.length,
        examples: workflows.slice(0, 5),
        percentage: Math.round((workflows.length / 2053) * 100)
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(categoryStats, null, 2)
        }
      ]
    };
  }

  async getIntegrations(args) {
    const { sort_by = 'count' } = args;
    
    const integrations = {};
    const rows = this.db.prepare('SELECT integrations FROM workflows').all();
    
    rows.forEach(row => {
      const ints = JSON.parse(row.integrations || '[]');
      ints.forEach(int => {
        integrations[int] = (integrations[int] || 0) + 1;
      });
    });

    let sorted = Object.entries(integrations);
    if (sort_by === 'count') {
      sorted.sort((a, b) => b[1] - a[1]);
    } else {
      sorted.sort((a, b) => a[0].localeCompare(b[0]));
    }

    const result = sorted.map(([name, count]) => ({
      name,
      count,
      percentage: Math.round((count / 2053) * 100)
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total_integrations: result.length,
            integrations: result
          }, null, 2)
        }
      ]
    };
  }

  async analyzeWorkflow(args) {
    const { workflow_json } = args;
    
    let workflow;
    try {
      workflow = JSON.parse(workflow_json);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }

    const analysis = {
      name: workflow.name || 'Unnamed Workflow',
      active: workflow.active || false,
      node_count: workflow.nodes ? workflow.nodes.length : 0,
      complexity: this.getComplexityLevel(workflow.nodes ? workflow.nodes.length : 0),
      trigger_type: this.determineTriggerType(workflow),
      integrations: this.extractIntegrations(workflow),
      node_types: {},
      connections: workflow.connections ? Object.keys(workflow.connections).length : 0,
      has_credentials: false,
      validation_issues: []
    };

    // Analyze node types
    if (workflow.nodes) {
      workflow.nodes.forEach(node => {
        analysis.node_types[node.type] = (analysis.node_types[node.type] || 0) + 1;
        if (node.credentials) {
          analysis.has_credentials = true;
        }
      });
    }

    // Basic validation
    if (!workflow.nodes || workflow.nodes.length === 0) {
      analysis.validation_issues.push('No nodes found');
    }
    if (!workflow.connections) {
      analysis.validation_issues.push('No connections defined');
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(analysis, null, 2)
        }
      ]
    };
  }

  async generateDiagram(args) {
    const { filename } = args;
    
    const filePath = join(this.config.workflowsDir, filename);
    const workflow = JSON.parse(readFileSync(filePath, 'utf8'));

    let diagram = 'graph TD\n';
    const nodeMap = {};

    // Add nodes
    if (workflow.nodes) {
      workflow.nodes.forEach((node, idx) => {
        const nodeId = `node${idx}`;
        nodeMap[node.name] = nodeId;
        
        let nodeLabel = node.name.replace(/[^a-zA-Z0-9 ]/g, '');
        let nodeStyle = '';
        
        if (node.type.includes('trigger')) {
          nodeStyle = ':::trigger';
        } else if (node.type.includes('webhook')) {
          nodeStyle = ':::webhook';
        }
        
        diagram += `  ${nodeId}["${nodeLabel}<br/>${node.type}"]${nodeStyle}\n`;
      });
    }

    // Add connections
    if (workflow.connections) {
      Object.entries(workflow.connections).forEach(([sourceName, targets]) => {
        const sourceId = nodeMap[sourceName];
        if (sourceId && targets) {
          Object.entries(targets).forEach(([output, connections]) => {
            connections.forEach(conn => {
              const targetId = nodeMap[conn.node];
              if (targetId) {
                diagram += `  ${sourceId} --> ${targetId}\n`;
              }
            });
          });
        }
      });
    }

    // Add styles
    diagram += '\n';
    diagram += 'classDef trigger fill:#f9f,stroke:#333,stroke-width:2px;\n';
    diagram += 'classDef webhook fill:#9ff,stroke:#333,stroke-width:2px;\n';

    return {
      content: [
        {
          type: 'text',
          text: diagram
        }
      ]
    };
  }

  async exportWorkflow(args) {
    const { filename, remove_credentials = true, format = 'json' } = args;
    
    const filePath = join(this.config.workflowsDir, filename);
    let workflow = JSON.parse(readFileSync(filePath, 'utf8'));

    if (remove_credentials && workflow.nodes) {
      workflow.nodes.forEach(node => {
        if (node.credentials) {
          delete node.credentials;
        }
      });
    }

    let output;
    if (format === 'json') {
      output = JSON.stringify(workflow, null, 2);
    } else if (format === 'yaml') {
      // Simple YAML conversion (would need a proper library in production)
      output = '# N8N Workflow Export\n';
      output += `name: ${workflow.name}\n`;
      output += `active: ${workflow.active}\n`;
      output += `nodes:\n`;
      workflow.nodes.forEach(node => {
        output += `  - name: ${node.name}\n`;
        output += `    type: ${node.type}\n`;
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: output
        }
      ]
    };
  }

  async bulkAnalyze(args) {
    const { criteria = {} } = args;
    
    let sql = 'SELECT * FROM workflows WHERE 1=1';
    const params = [];

    if (criteria.min_nodes) {
      sql += ' AND node_count >= ?';
      params.push(criteria.min_nodes);
    }
    if (criteria.max_nodes) {
      sql += ' AND node_count <= ?';
      params.push(criteria.max_nodes);
    }
    if (criteria.trigger_types && criteria.trigger_types.length > 0) {
      sql += ` AND trigger_type IN (${criteria.trigger_types.map(() => '?').join(',')})`;
      params.push(...criteria.trigger_types);
    }

    const workflows = this.db.prepare(sql).all(...params);

    // Filter by integrations if specified
    let filtered = workflows;
    if (criteria.must_include_integrations && criteria.must_include_integrations.length > 0) {
      filtered = workflows.filter(w => {
        const ints = JSON.parse(w.integrations || '[]');
        return criteria.must_include_integrations.every(req => ints.includes(req));
      });
    }

    // Analyze patterns
    const patterns = {
      total_matching: filtered.length,
      common_integrations: {},
      trigger_distribution: {},
      complexity_distribution: {},
      average_nodes: 0
    };

    let totalNodes = 0;
    filtered.forEach(w => {
      // Integrations
      const ints = JSON.parse(w.integrations || '[]');
      ints.forEach(int => {
        patterns.common_integrations[int] = (patterns.common_integrations[int] || 0) + 1;
      });

      // Triggers
      patterns.trigger_distribution[w.trigger_type] = 
        (patterns.trigger_distribution[w.trigger_type] || 0) + 1;

      // Complexity
      const complexity = this.getComplexityLevel(w.node_count);
      patterns.complexity_distribution[complexity] = 
        (patterns.complexity_distribution[complexity] || 0) + 1;

      totalNodes += w.node_count;
    });

    patterns.average_nodes = filtered.length > 0 ? Math.round(totalNodes / filtered.length) : 0;

    // Sort common integrations
    patterns.common_integrations = Object.entries(patterns.common_integrations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {});

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(patterns, null, 2)
        }
      ]
    };
  }

  async findSimilar(args) {
    const { filename, similarity_threshold = 0.7 } = args;
    
    // Get reference workflow
    const reference = this.db.prepare('SELECT * FROM workflows WHERE filename = ?').get(filename);
    if (!reference) {
      throw new Error(`Workflow not found: ${filename}`);
    }

    const refIntegrations = JSON.parse(reference.integrations || '[]');
    const allWorkflows = this.db.prepare('SELECT * FROM workflows WHERE filename != ?').all(filename);

    const similarities = [];

    allWorkflows.forEach(workflow => {
      const wfIntegrations = JSON.parse(workflow.integrations || '[]');
      
      // Calculate Jaccard similarity
      const intersection = refIntegrations.filter(i => wfIntegrations.includes(i)).length;
      const union = new Set([...refIntegrations, ...wfIntegrations]).size;
      const integrationSimilarity = union > 0 ? intersection / union : 0;

      // Consider node count similarity
      const nodeDiff = Math.abs(reference.node_count - workflow.node_count);
      const nodeCountSimilarity = 1 - (nodeDiff / Math.max(reference.node_count, workflow.node_count));

      // Consider trigger type
      const triggerSimilarity = reference.trigger_type === workflow.trigger_type ? 1 : 0.5;

      // Combined similarity score
      const similarity = (integrationSimilarity * 0.5 + nodeCountSimilarity * 0.3 + triggerSimilarity * 0.2);

      if (similarity >= similarity_threshold) {
        similarities.push({
          filename: workflow.filename,
          name: workflow.name,
          similarity_score: Math.round(similarity * 100) / 100,
          shared_integrations: refIntegrations.filter(i => wfIntegrations.includes(i)),
          trigger_type: workflow.trigger_type,
          node_count: workflow.node_count
        });
      }
    });

    // Sort by similarity score
    similarities.sort((a, b) => b.similarity_score - a.similarity_score);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            reference_workflow: {
              filename: reference.filename,
              name: reference.name,
              integrations: refIntegrations,
              node_count: reference.node_count
            },
            similar_workflows: similarities.slice(0, 20),
            total_found: similarities.length
          }, null, 2)
        }
      ]
    };
  }

  async createWorkflowTemplate(args) {
    const { name, integrations, trigger_type, description = '' } = args;
    
    // Find example workflows that use similar integrations
    const examples = this.db.prepare(`
      SELECT * FROM workflows 
      WHERE trigger_type = ? 
      ORDER BY node_count
      LIMIT 5
    `).all(trigger_type);

    // Basic workflow template structure
    const template = {
      name,
      nodes: [],
      connections: {},
      active: false,
      settings: {},
      id: this.generateWorkflowId()
    };

    // Add trigger node based on type
    let triggerNode;
    switch (trigger_type) {
      case 'Webhook':
        triggerNode = {
          parameters: {
            path: `/${name.toLowerCase().replace(/\s+/g, '-')}`,
            options: {}
          },
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          position: [250, 300],
          webhookId: this.generateWebhookId()
        };
        break;
      case 'Scheduled':
        triggerNode = {
          parameters: {
            rule: {
              interval: [{ hours: 1 }]
            }
          },
          name: 'Schedule Trigger',
          type: 'n8n-nodes-base.scheduleTrigger',
          position: [250, 300]
        };
        break;
      default:
        triggerNode = {
          parameters: {},
          name: 'Start',
          type: 'n8n-nodes-base.start',
          position: [250, 300]
        };
    }

    template.nodes.push(triggerNode);

    // Add basic nodes for each integration
    let xPos = 450;
    integrations.forEach((integration, idx) => {
      const node = {
        parameters: {},
        name: integration,
        type: this.getNodeTypeForIntegration(integration),
        position: [xPos, 300],
        credentials: {}
      };
      
      template.nodes.push(node);
      
      // Add connection from previous node
      const prevNodeName = idx === 0 ? triggerNode.name : integrations[idx - 1];
      if (!template.connections[prevNodeName]) {
        template.connections[prevNodeName] = {
          main: [[{ node: integration, type: 'main', index: 0 }]]
        };
      }
      
      xPos += 200;
    });

    // Add metadata
    const metadata = {
      description,
      created_at: new Date().toISOString(),
      template_version: '1.0',
      based_on_examples: examples.slice(0, 3).map(e => e.filename)
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            workflow: template,
            metadata,
            usage_instructions: [
              `1. Import this template into n8n`,
              `2. Configure credentials for: ${integrations.join(', ')}`,
              `3. Adjust node parameters as needed`,
              `4. Test the workflow before activating`
            ]
          }, null, 2)
        }
      ]
    };
  }

  async validateWorkflow(args) {
    const { workflow_json } = args;
    
    let workflow;
    try {
      workflow = JSON.parse(workflow_json);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              valid: false,
              errors: [`JSON parsing error: ${error.message}`]
            }, null, 2)
          }
        ]
      };
    }

    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      info: {
        nodes: workflow.nodes ? workflow.nodes.length : 0,
        connections: workflow.connections ? Object.keys(workflow.connections).length : 0,
        has_trigger: false,
        has_credentials: false
      }
    };

    // Check required fields
    if (!workflow.name) {
      validation.errors.push('Workflow must have a name');
      validation.valid = false;
    }

    if (!workflow.nodes || workflow.nodes.length === 0) {
      validation.errors.push('Workflow must have at least one node');
      validation.valid = false;
    }

    if (!workflow.connections) {
      validation.warnings.push('Workflow has no connections defined');
    }

    // Validate nodes
    if (workflow.nodes) {
      const nodeNames = new Set();
      
      workflow.nodes.forEach((node, idx) => {
        if (!node.name) {
          validation.errors.push(`Node at index ${idx} has no name`);
          validation.valid = false;
        }
        
        if (!node.type) {
          validation.errors.push(`Node "${node.name}" has no type`);
          validation.valid = false;
        }
        
        if (!node.position || !Array.isArray(node.position) || node.position.length !== 2) {
          validation.warnings.push(`Node "${node.name}" has invalid position`);
        }
        
        if (nodeNames.has(node.name)) {
          validation.errors.push(`Duplicate node name: "${node.name}"`);
          validation.valid = false;
        }
        nodeNames.add(node.name);
        
        if (node.type.includes('trigger') || node.type.includes('Trigger')) {
          validation.info.has_trigger = true;
        }
        
        if (node.credentials) {
          validation.info.has_credentials = true;
        }
      });
    }

    // Validate connections
    if (workflow.connections) {
      Object.entries(workflow.connections).forEach(([source, targets]) => {
        if (!workflow.nodes.find(n => n.name === source)) {
          validation.errors.push(`Connection from non-existent node: "${source}"`);
          validation.valid = false;
        }
        
        if (targets.main) {
          targets.main.forEach(outputs => {
            outputs.forEach(conn => {
              if (!workflow.nodes.find(n => n.name === conn.node)) {
                validation.errors.push(`Connection to non-existent node: "${conn.node}"`);
                validation.valid = false;
              }
            });
          });
        }
      });
    }

    if (!validation.info.has_trigger) {
      validation.warnings.push('Workflow has no trigger node - will need manual execution');
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(validation, null, 2)
        }
      ]
    };
  }

  async getWorkflowRecommendations(args) {
    const { use_case, preferred_integrations = [] } = args;
    
    // Keywords extraction from use case
    const keywords = use_case.toLowerCase().split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !['with', 'from', 'that', 'this', 'have', 'been', 'will'].includes(word));

    // Search for relevant workflows
    let searchQuery = keywords.join(' OR ');
    if (preferred_integrations.length > 0) {
      searchQuery += ' ' + preferred_integrations.join(' ');
    }

    const results = this.db.prepare(`
      SELECT w.*, 
        (SELECT COUNT(*) FROM workflows_fts WHERE workflows_fts MATCH ?) as relevance
      FROM workflows w
      WHERE w.id IN (SELECT rowid FROM workflows_fts WHERE workflows_fts MATCH ?)
      ORDER BY relevance DESC
      LIMIT 20
    `).all(searchQuery, searchQuery);

    // Score and rank results
    const scored = results.map(workflow => {
      let score = workflow.relevance * 10;
      
      // Boost score for matching integrations
      const wfIntegrations = JSON.parse(workflow.integrations || '[]');
      preferred_integrations.forEach(pref => {
        if (wfIntegrations.some(int => int.toLowerCase().includes(pref.toLowerCase()))) {
          score += 20;
        }
      });
      
      // Boost for active workflows
      if (workflow.active) score += 5;
      
      // Consider description relevance
      if (workflow.description) {
        keywords.forEach(keyword => {
          if (workflow.description.toLowerCase().includes(keyword)) {
            score += 3;
          }
        });
      }
      
      return { ...workflow, recommendation_score: score };
    });

    // Sort by recommendation score
    scored.sort((a, b) => b.recommendation_score - a.recommendation_score);

    // Prepare recommendations
    const recommendations = scored.slice(0, 10).map(wf => ({
      filename: wf.filename,
      name: wf.name,
      description: wf.description,
      score: wf.recommendation_score,
      integrations: JSON.parse(wf.integrations || '[]'),
      trigger_type: wf.trigger_type,
      complexity: this.getComplexityLevel(wf.node_count),
      reasons: this.generateRecommendationReasons(wf, keywords, preferred_integrations)
    }));

    // Group by category
    const byCategory = {};
    const categories = this.loadCategories();
    
    recommendations.forEach(rec => {
      for (const [cat, workflows] of Object.entries(categories)) {
        if (workflows.includes(rec.filename)) {
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(rec);
          break;
        }
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            use_case,
            keywords_detected: keywords,
            total_recommendations: recommendations.length,
            top_recommendations: recommendations,
            by_category: byCategory,
            search_tips: [
              'Try being more specific about the services you want to integrate',
              'Mention the trigger type you prefer (webhook, scheduled, manual)',
              'Include specific actions you want to automate'
            ]
          }, null, 2)
        }
      ]
    };
  }

  // Helper methods
  loadCategories() {
    if (existsSync(this.config.categoriesPath)) {
      return JSON.parse(readFileSync(this.config.categoriesPath, 'utf8'));
    }
    return {};
  }

  getComplexityLevel(nodeCount) {
    if (nodeCount <= 5) return 'low';
    if (nodeCount <= 15) return 'medium';
    return 'high';
  }

  determineTriggerType(workflow) {
    if (!workflow.nodes) return 'Unknown';
    
    const triggerNodes = workflow.nodes.filter(n => 
      n.type.includes('trigger') || 
      n.type.includes('Trigger') ||
      n.type.includes('webhook')
    );

    if (triggerNodes.length === 0) return 'Manual';
    if (triggerNodes.length > 1) return 'Complex';
    
    const triggerType = triggerNodes[0].type;
    if (triggerType.includes('webhook')) return 'Webhook';
    if (triggerType.includes('schedule')) return 'Scheduled';
    if (triggerType.includes('trigger')) return 'Triggered';
    
    return 'Manual';
  }

  extractIntegrations(workflow) {
    const integrations = new Set();
    
    if (workflow.nodes) {
      workflow.nodes.forEach(node => {
        const type = node.type;
        if (type && !type.includes('n8n-nodes-base.')) {
          const integration = type.split('.')[0];
          if (integration && !['start', 'noOp', 'function', 'set'].includes(integration)) {
            integrations.add(integration);
          }
        } else if (type) {
          const parts = type.split('.');
          if (parts.length > 1) {
            const nodeName = parts[1];
            if (!['start', 'noOp', 'function', 'set', 'if', 'merge', 'switch'].includes(nodeName)) {
              integrations.add(nodeName.charAt(0).toUpperCase() + nodeName.slice(1));
            }
          }
        }
      });
    }
    
    return Array.from(integrations);
  }

  generateWorkflowId() {
    return Math.random().toString(36).substring(2, 15);
  }

  generateWebhookId() {
    return createHash('md5').update(Date.now().toString()).digest('hex').substring(0, 16);
  }

  getNodeTypeForIntegration(integration) {
    // Map common integrations to node types
    const typeMap = {
      'Telegram': 'n8n-nodes-base.telegram',
      'Slack': 'n8n-nodes-base.slack',
      'Discord': 'n8n-nodes-base.discord',
      'Gmail': 'n8n-nodes-base.gmail',
      'Google Drive': 'n8n-nodes-base.googleDrive',
      'HTTP Request': 'n8n-nodes-base.httpRequest',
      'PostgreSQL': 'n8n-nodes-base.postgres',
      'MySQL': 'n8n-nodes-base.mySql',
      'MongoDB': 'n8n-nodes-base.mongoDb',
      'Redis': 'n8n-nodes-base.redis'
    };
    
    return typeMap[integration] || 'n8n-nodes-base.httpRequest';
  }

  generateRecommendationReasons(workflow, keywords, preferredIntegrations) {
    const reasons = [];
    const wfIntegrations = JSON.parse(workflow.integrations || '[]');
    
    // Check keyword matches
    const keywordMatches = keywords.filter(k => 
      workflow.name.toLowerCase().includes(k) || 
      (workflow.description && workflow.description.toLowerCase().includes(k))
    );
    
    if (keywordMatches.length > 0) {
      reasons.push(`Matches keywords: ${keywordMatches.join(', ')}`);
    }
    
    // Check integration matches
    const integrationMatches = preferredIntegrations.filter(pref =>
      wfIntegrations.some(int => int.toLowerCase().includes(pref.toLowerCase()))
    );
    
    if (integrationMatches.length > 0) {
      reasons.push(`Uses requested integrations: ${integrationMatches.join(', ')}`);
    }
    
    if (workflow.active) {
      reasons.push('Currently active workflow');
    }
    
    if (workflow.node_count > 10) {
      reasons.push('Comprehensive automation with multiple steps');
    }
    
    return reasons;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('N8N Workflows MCP server running on stdio');
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new N8NWorkflowsMCPServer();
  server.run().catch(console.error);
}