import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const CLIENT_CONFIGS = {
 goldstar: {
 name: 'Goldstar Plumbing',
 apiKey: process.env.GOLDSTAR_API_KEY,
 instructions:
 'You are a friendly receptionist for Goldstar Plumbing. Answer questions about leaks, water heaters, and drain cleaning. Encourage them to book a technician at (425) 300-9900.',
 },
};

// Basic HTTP handler for health + n8n relay
function requestHandler(req, res) {
 if (req.method === 'GET' && req.url === '/') {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 return res.end(JSON.stringify({ status: 'ok' }));
 }

 if (req.method === 'POST' && req.url === '/relay') {
 let body = '';
 req.on('data', (chunk) => {
 body += chunk;
 if (body.length > 1e6) req.socket.destroy();
 });
 req.on('end', () => {
 try {
 const data = JSON.parse(body || '{}');
 console.log('Received from n8n:', data);

 // TODO: hook this into your Gemini / Twilio logic as needed

 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ ok: true, received: data }));
 } catch (e) {
 res.writeHead(400, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
 }
 });
 return;
 }

 res.writeHead(404);
 res.end();
}

const server = createServer(requestHandler);

// WebSocket server for existing logic
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
 console.log('New connection attempt...');
 const urlParams = new URLSearchParams(req.url.split('?')[1]);
 const clientId = urlParams.get('client') || 'goldstar';
 const config = CLIENT_CONFIGS[clientId];

 if (!config || !config.apiKey) {
 console.error('Invalid configuration or missing API Key');
 ws.close();
 return;
 }

 // Your existing Gemini WebSocket logic continues here...
 // (keep whatever you already had after this point)
});

// IMPORTANT: listen on Render’s port
const port = process.env.PORT || 3000;
server.listen(port, () => {
 console.log(`Server listening on port ${port}`);
});

