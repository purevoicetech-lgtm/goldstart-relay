import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import pkg from 'alawmulaw';
const { mulaw } = pkg;

const CLIENT_CONFIGS = {
    goldstar: {
        name: 'Goldstar Plumbing',
        apiKey: process.env.GOLDSTAR_API_KEY,
        instructions: 'You are a friendly receptionist for Goldstar Plumbing. Answer questions about leaks, water heaters, and drain cleaning. Encourage them to book a technician at (425) 300-9900.'
    }
};

// --- AUDIO HELPERS ---

// Upsample 8kHz PCM to 16kHz PCM
function upsample8to16(pcm8) {
    const result = new Int16Array(pcm8.length * 2);
    for (let i = 0; i < pcm8.length; i++) {
        result[i * 2] = pcm8[i];
        result[i * 2 + 1] = pcm8[i];
    }
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
}

// Downsample 24kHz PCM to 8kHz PCM
function downsample24to8(buffer) {
    const pcm24 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    const result = new Int16Array(Math.floor(pcm24.length / 3));
    for (let i = 0; i < result.length; i++) {
        result[i] = pcm24[i * 3];
    }
    return result;
}

// --- SERVER SETUP ---

const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/relay') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Relay is active');
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    console.log('New connection attempt from Twilio...');
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const clientId = urlParams.get('client') || 'goldstar';
    const config = CLIENT_CONFIGS[clientId];

    if (!config || !config.apiKey) {
        console.error('ERROR: Missing API Key or Config for client:', clientId);
        ws.close();
        return;
    }

    console.log(`Baton handover: ${config.name} AI is waking up...`);

    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.apiKey)}`;
    const geminiWs = new WebSocket(geminiUrl);

    geminiWs.on('open', () => {
        console.log('CONNECTED to Gemini AI WebSocket');
    });

    let streamSid = null;

    // --- TWILIO -> GEMINI ---
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                console.log('Stream sequence started:', streamSid);

                const sendSetup = () => {
                    console.log(`Sending setup to Gemini (State: ${geminiWs.readyState})`);
                    if (geminiWs.readyState === WebSocket.OPEN) {
                        const setupMsg = {
                            setup: {
                                model: "models/gemini-2.0-flash-exp",
                                generation_config: {
                                    response_modalities: ["AUDIO"],
                                    speech_config: {
                                        voice_config: {
                                            prebuilt_voice_config: {
                                                voice_name: "Puck"
                                            }
                                        }
                                    }
                                },
                                system_instruction: { parts: [{ text: config.instructions }] }
                            }
                        };
                        console.log('Setup message:', JSON.stringify(setupMsg, null, 2));
                        geminiWs.send(JSON.stringify(setupMsg));
                    } else {
                        console.error('Failed to send setup: Gemini WebSocket not OPEN (ReadyState: ' + geminiWs.readyState + ')');
                    }
                };

                if (geminiWs.readyState === WebSocket.CONNECTING) {
                    geminiWs.once('open', sendSetup);
                } else {
                    sendSetup();
                }
            }

            if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
                // 1. Decode Mulaw (8kHz) to PCM16 (8kHz)
                const pcm8 = mulaw.decode(Buffer.from(data.media.payload, 'base64'));

                // 2. Upsample to 16kHz for Gemini
                const pcm16 = upsample8to16(pcm8);

                // 3. Send to Gemini
                const inputMsg = {
                    realtime_input: {
                        media_chunks: [{
                            data: pcm16.toString('base64'),
                            mime_type: "audio/pcm;rate=16000"
                        }]
                    }
                };
                geminiWs.send(JSON.stringify(inputMsg));
            }

            if (data.event === 'stop') {
                console.log('Call ended via Twilio stop event');
                geminiWs.close();
            }
        } catch (e) {
            console.error('Relay Error (Twilio side):', e.message);
        }
    });

    // --- GEMINI -> TWILIO ---
    let audioChunkCount = 0;
    geminiWs.on('message', (message) => {
        try {
            const response = JSON.parse(message);

            // Handle both setup_complete (snake_case) and setupComplete (camelCase)
            if (response.setup_complete || response.setupComplete) {
                console.log('Gemini AI is ready and listening!');

                // Trigger an initial greeting so the user knows it's working
                console.log('Triggering initial greeting...');
                geminiWs.send(JSON.stringify({
                    client_content: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "Hello! Please greet the caller and introduce yourself." }]
                        }],
                        turn_complete: true
                    }
                }));
            }

            // Log every message from Gemini briefly to see the structure
            console.log('Gemini message keys:', Object.keys(response));

            // Handle both server_content (snake_case) and serverContent (camelCase)
            const serverContent = response.server_content || response.serverContent;
            if (serverContent) {
                // Handle both model_turn (snake_case) and modelTurn (camelCase)
                const modelTurn = serverContent.model_turn || serverContent.modelTurn;
                if (modelTurn?.parts) {
                    modelTurn.parts.forEach(part => {
                        const audioData = part.inline_data?.data || part.inlineData?.data;
                        if (audioData && streamSid) {
                            audioChunkCount++;
                            if (audioChunkCount === 1) console.log('FIRST audio chunk received from Gemini!');
                            if (audioChunkCount % 20 === 0) console.log(`Sending audio chunk #${audioChunkCount} to Twilio`);

                            // 1. Gemini sends 24kHz PCM
                            const pcm24Buffer = Buffer.from(audioData, 'base64');

                            // 2. Downsample to 8kHz
                            const pcm8 = downsample24to8(pcm24Buffer);

                            // 3. Encode to Mulaw for Twilio
                            const mulawBuffer = mulaw.encode(pcm8);

                            // 4. Send to Twilio
                            ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: streamSid,
                                media: { payload: Buffer.from(mulawBuffer).toString('base64') }
                            }));
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Relay Error (Gemini side):', e.message);
            console.error('Buffer details:', message.toString().substring(0, 100));
        }
    });

    ws.on('close', () => {
        console.log('Twilio connection closed');
        if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
            geminiWs.close();
        }
    });

    geminiWs.on('close', (code, reason) => {
        console.log(`Gemini session ended (Code: ${code}, Reason: ${reason || 'none'})`);
        ws.close();
    });
    geminiWs.on('error', (err) => console.error('Gemini Connection Error:', err.message));
    ws.on('error', (err) => console.error('Twilio Connection Error:', err.message));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Relay server live on port ${PORT}`);
});
