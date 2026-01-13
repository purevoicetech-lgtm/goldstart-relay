/**
 * Multi-Tenant Relay Server for Twilio <-> Gemini/OpenAI Voice
 * 
 * HOSTING:
 * Recommended: Use a subdomain like 'relay.purevoice.tech'. 
 * Subfolders can have routing issues with WebSockets.
 * 
 * USAGE:
 * Point your Twilio Stream to: wss://relay.purevoice.tech/stream?client=client_id
 */

import WebSocket from 'ws';
import { createServer } from 'http';

// CONFIGURATION: Add your clients here
const CLIENT_CONFIGS = {
    'goldstar': {
        name: 'Goldstar Plumbing',
        apiKey: process.env.GOLDSTAR_API_KEY, // Set this in your environment variables
        systemPrompt: "You are a helpful assistant for Goldstar Plumbing...",
        voice: "alloy"
    },
    'another-client': {
        name: 'Another Client',
        apiKey: process.env.ANOTHER_CLIENT_KEY,
        systemPrompt: "You are a receptionist...",
        voice: "shimmer"
    }
};

const server = createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    console.log('New connection attempt...');

    // 1. Extract Client ID from URL (e.g., /stream?client=goldstar)
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const clientId = urlParams.get('client');

    if (!clientId || !CLIENT_CONFIGS[clientId]) {
        console.error(`Invalid or missing client ID: ${clientId}`);
        ws.close();
        return;
    }

    const config = CLIENT_CONFIGS[clientId];
    console.log(`Client identified: ${config.name}`);

    // 2. Setup Upstream Connection (to Gemini/OpenAI)
    // NOTE: This is a placeholder for the actual Gemini/OpenAI WebSocket logic.
    // You will need to install the specific SDK or use raw WebSockets depending on the provider.

    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case 'start':
                console.log(`Twilio Stream started: ${msg.streamSid}`);
                break;
            case 'media':
                // Receive audio from Twilio (base64)
                // const audioPayload = msg.media.payload;
                // TODO: Send 'audioPayload' to Gemini Live API
                break;
            case 'stop':
                console.log('Twilio Stream stopped');
                break;
        }
    });

    // TODO: When receiving audio FROM Gemini:
    // const audioResponse = ...; 
    // const payload = {
    //     event: 'media',
    //     streamSid: streamSid,
    //     media: { payload: audioResponse }
    // };
    // ws.send(JSON.stringify(payload));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Relay server listening on port ${PORT}`);
});
