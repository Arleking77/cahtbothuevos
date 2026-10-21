import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Se usa gemini-1.5-flash para máxima compatibilidad con API keys gratuitas
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reintentando...', shouldReconnect);
            if (shouldReconnect) iniciarBot();
        } else if (connection === 'open') {
            console.log('¡Bot de Huevos HLE conectado con éxito a WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const textoCliente = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!textoCliente) return;

        console.log(`Mensaje recibido de ${remoteJid}: ${textoCliente}`);

        try {
            const prompt = `Eres la asistente virtual del Gallinero Huevos HLE. Atiendes con amabilidad en español chileno.
            Ofreces 2 formas de pago:
            1. Pago Ahora (Mercado Pago).
            2. Pago al Recibir (Contra Entrega).
            
            Responde en máximo 2 o 3 frases al cliente: "${textoCliente}"`;

            const result = await model.generateContent(prompt);
            const respuestaIA = result.response.text();

            await sock.sendMessage(remoteJid, { text: respuestaIA });
            console.log(`Respuesta enviada con éxito a ${remoteJid}`);

        } catch (error) {
            console.error('Error al procesar con la IA:', error);
        }
    });
}

iniciarBot();