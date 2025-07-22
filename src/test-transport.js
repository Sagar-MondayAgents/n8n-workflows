import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

console.error('Testing StdioServerTransport...');

try {
  const transport = new StdioServerTransport();
  console.error('Transport created successfully');
  
  // Test if stdin is available
  console.error('process.stdin properties:', {
    readable: process.stdin.readable,
    isTTY: process.stdin.isTTY,
    destroyed: process.stdin.destroyed
  });
  
  // Try to set encoding
  process.stdin.setEncoding('utf8');
  console.error('Set encoding successfully');
  
} catch (error) {
  console.error('Transport test failed:', error.message);
  console.error('Stack:', error.stack);
}