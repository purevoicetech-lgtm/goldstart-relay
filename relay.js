import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { mulaw } from 'alawmulaw';

const CLIENT_CONFIGS = {
    goldstar: {
        name: 'Goldstar Plumbing',
        apiKey: process.env.GOLDSTAR_API_KEY,
        instructions:
            'You are a friendly receptionist for Goldstar Plumbing. Answer questions about leaks, water heaters, and drain cleaning. Encourage them to book a technician at (425) 300-9900.',
    },
};

// --- AUDIO HELPERS ---

// Up-sample 8kHz PCM to 16kHz PCM (linear duplication)
function upsample8to16(buffer) {
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    const result = new Int16Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        result[i * 2] = samples[i];
        result[i * 2 + 1] = samples[i];
    }
    return Buffer.from(result.buffer);
}

// Down-sample 24kHz PCM to 8kHz PCM (simple decimation)
function downsample24to8(buffer) {
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    const result = new Int16Array(Math.floor(samples.length / 3));
    for (let i = 0; i < result.length; i++) {
        result[i] = samples[i * 3];
    }
    return Buffer.from(result.buffer);
}

// --- SERVER LOGIC ---

function requestHandler(req, res) {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (req.method === 'POST' && req.url === '/relay') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }
    res.writeHead(404);
    res.end();
}

const server = createServer(requestHandler);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    console.log('New connection attempt...');
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const clientId = urlParams.get('client') || 'goldstar';
    const config = CLIENT_CONFIGS[clientId];

    if (!config || !config.apiKey) {
        console.error('Missing API Key or Config');
        ws.close();
        return;
    }

    console.log(`Talking to Goldstar AI (Gemini)...`);

    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${config.apiKey}`;
    const geminiWs = new WebSocket(geminiUrl);

    let streamSid = null;

    // --- TWILIO -> RELAY -> GEMINI ---
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                console.log('Call started:', streamSid);

                // Gemini Setup
                geminiWs.send(JSON.stringify({
                    setup: {
                        model: "models/gemini-2.0-flash-exp",
                        generation_config: {
                            response_modalities: ["AUDIO"],
                            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
                        },
                        system_instruction: { parts: [{ text: config.instructions }] }
                    }
                }));
            }

            if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
                // 1. Decode Mulaw (8kHz) to PCM16 (8kHz)
                const mulawBuffer = Buffer.from(data.media.payload, 'base64');
                const pcm8 = mulaw.decode(mulawBuffer);

                // 2. Upsample PCM16 (8kHz) to PCM16 (16kHz)
                const pcm16 = upsample8to16(Buffer.from(pcm8.buffer));

                // 3. Send to Gemini
                geminiWs.send(JSON.stringify({
                    realtime_input: {
                        media_chunks: [{
                            data: pcm16.toString('base64'),
                            mime_type: "audio/pcm;rate=16000"
                        }]
                    }
                }));
            }
        } catch (e) {
            console.error('Twilio Error:', e);
        }
    });

    // --- GEMINI -> RELAY -> TWILIO ---
    geminiWs.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.server_content && response.server_content.model_turn) {
                const parts = response.server_content.model_turn.parts;
                parts.forEach(part => {
                    if (part.inline_data && part.inline_data.data && streamSid) {
                        // 1. Response is PCM16 (24kHz)
                        const pcm24 = Buffer.from(part.inline_data.data, 'base64');

                        // 2. Downsample PCM16 (24kHz) to PCM16 (8kHz)
                        const pcm8 = downsample24to8(pcm24);

                        // 3. Encode PCM16 (8kHz) to Mulaw (8kHz)
                        const mulawEncoded = mulaw.encode(new Int16Array(pcm8.buffer, pcm8.byteOffset, pcm8.length / 2));

                        // 4. Send to Twilio
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: Buffer.from(mulawEncoded).toString('base64') }
                        }));
                    }
                });
            }
        } catch (e) {
            console.error('Gemini Error:', e);
        }
    });

    ws.on('close', () => { console.log('Call ended'); geminiWs.close(); });
    geminiWs.on('close', () => { console.log('AI closed'); ws.close(); });
    geminiWs.on('error', (err) => console.error('Gemini error:', err));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('Relay listening on', PORT));
