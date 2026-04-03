#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const packageDir = path.resolve(__dirname, '..');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Check if .env.local exists, create template if not
const envPath = path.join(process.cwd(), '.env.local');
if (!fs.existsSync(envPath)) {
  const template = `# Org Studio Configuration
# Uncomment and set these for advanced features:

# PostgreSQL (for remote access + multi-instance sync)
# DATABASE_URL=postgresql://user:pass@host:5432/org_studio_db?sslmode=require

# API key for store mutations (auto-generated if not set)
# ORG_STUDIO_API_KEY=your-secret-key

# OpenClaw Gateway (auto-detected on default port)
# GATEWAY_URL=ws://127.0.0.1:18789
# GATEWAY_TOKEN=your-gateway-token

# Telegram notifications (optional)
# VISION_TOPIC_GROUP_ID=
# VISION_TOPIC_BOT_TOKEN=
`;
  fs.writeFileSync(envPath, template);
  console.log('✓ Created .env.local template');
}

const port = process.env.PORT || 4501;
console.log(`\n ▲ Org Studio v1.0.0`);
console.log(` Starting on http://localhost:${port}\n`);

// Start the server
const server = spawn('node', ['server.mjs'], {
  cwd: packageDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
  },
});

server.on('close', (code) => {
  process.exit(code);
});

process.on('SIGINT', () => {
  server.kill('SIGINT');
});
