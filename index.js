const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4302;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'n8n-workflows', port: PORT });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'n8n-workflows service running', version: '1.0.0' });
});

// Add your MCP HTTP endpoints here
app.post('/mcp/*', (req, res) => {
  // Handle MCP requests
  res.json({ message: 'MCP endpoint', path: req.path });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`n8n-workflows service listening on port ${PORT}`);
});
