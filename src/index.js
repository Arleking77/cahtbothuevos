import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import dotenv from 'dotenv';
import http from 'http';
import fetch from 'node-fetch';

dotenv.config();

const URL_APPS_SCRIPT = process.env.URL_APPS_SCRIPT;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

let mpClient = null;
if (MP_ACCESS_TOKEN) {
    try {
        mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
        console.log("[Mercado Pago] SDK inicializado correctamente.");
    } catch (e) {
        console.error("[Mercado Pago Error]:", e.message);
    }
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODELO_SEGURO = "gemini-1.5-flash";

const sesionesChat = {};
const processedMessages = new Set();

async function obtenerDatosSheets() {
    try {
        if (!URL_APPS_SCRIPT) return { stock: [], clientes: {}, despachos: [] };
        const res = await fetch(URL_APPS_SCRIPT, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const text = await res.text();
        const data = JSON.parse(text);
        const listaZonas = data.despachos || data.zonas || [];
        console.log(`[Sheets Debug] Catálogo: ${data.stock?.length || 0} productos, Clientes: ${Object.keys(data.clientes || {}).length}, Zonas: ${listaZonas.length}`);
        return {
            stock: data.stock || [],
            clientes: data.clientes || {},
            despachos: listaZonas
        };
    } catch (e) {
        console.error("[Sheets Error]:", e.message);
        return { stock: [], clientes: {}, despachos: [] };
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection === 'open') {
            console.log('¡Bot de Huevos Santa Estela conectado con éxito a WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const messageId = msg.key.id;
            if (processedMessages.has(messageId)) return;
            processedMessages.add(messageId);
            setTimeout(() => processedMessages.delete(messageId), 60000);

            const currentJid = msg.key.remoteJid;
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!textMessage) return;

            const telefonoLimpio = currentJid.split('@')[0].replace(/\D/g, '');
            const telSufijo = telefonoLimpio.slice(-8);

            // Obtener datos de Google Sheets de forma segura
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const clientesMap = datosSheet.clientes || {};

            let usuario = null;
            for (let telKey in clientesMap) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    usuario = clientesMap[telKey];
                    break;
                }
            }

            // Si es un cliente nuevo o no está en la hoja, se activan campos nulos para pedírselos
            const esNuevo = !usuario;
            if (esNuevo) {
                usuario = { 
                    nombre: null, 
                    comuna: null, 
                    zona: "Santiago Sector 1" 
                };
            }

            // Mapeo seguro de precios por zona
            let zonaCliente = (usuario.zona || "").toLowerCase();
            let catalogoTexto = "";
            
            catalogo.forEach(p => {
                let precioFinal = p.precioStgo1 || p.precioLinares || 6000;
                if (zonaCliente.includes("sector 2")) {
                    precioFinal = p.precioStgo2 || precioFinal;
                } else if (zonaCliente.includes("linares")) {
                    precioFinal = p.precioLinares || precioFinal;
                } else {
                    precioFinal = p.precioStgo1 || precioFinal;
                }

                catalogoTexto += `- [ID: ${p.id}] ${p.categoria} (${p.descripcion} - ${p.formato}) -> Precio: $${precioFinal} CLP\n`;
            });

            // Gestión robusta de sesión de chat con memoria persistente
            if (!sesionesChat[telefonoLimpio]) {
                const model = genAI.getGenerativeModel({ model: MODELO_SEGURO });
                
                let promptSistema = `Eres el asistente virtual experto, directo y amable de "Huevos Santa Estela".
                
                DATOS DEL CLIENTE:
                - Nombre: ${usuario.nombre || 'No registrado'}
                - Comuna: ${usuario.comuna || 'No registrada'}
                - Zona de Despacho: ${usuario.zona}
                - Teléfono: ${telefonoLimpio}

                CATÁLOGO Y PRECIOS OFICIALES PARA SU ZONA:
                ${catalogoTexto}

                INSTRUCCIONES ESTRICTAS:
                1. RECONOCIMIENTO: Si el cliente ya tiene nombre y comuna registrados, salúdalo por su nombre y recuérdale su comuna. ¡ESTÁ PROHIBIDO volver a pedirle el nombre o la comuna!
                2. CLIENTES NUEVOS: Si el nombre o la comuna son nulos o no están registrados, salúdalo amablemente y pídele amablemente su nombre y comuna en un solo mensaje para registrarlo.
                3. PRECIOS: Usa los precios exactos indicados en el catálogo para su zona.
                `;

                sesionesChat[telefonoLimpio] = model.startChat({
                    history: [
                        { role: "user", parts: [{ text: "Iniciar sistema de ventas." }] },
                        { role: "model", parts: [{ text: `Entendido. Asistiendo a ${usuario.nombre || 'cliente nuevo'}. Mantendré la memoria activa.` }] }
                    ]
                });
            }

            const chatSession = sesionesChat[telefonoLimpio];
            const resultado = await chatSession.sendMessage(textMessage);
            const respuestaIA = resultado.response.text();

            await sock.sendMessage(currentJid, { text: respuestaIA });

        } catch (error) {
            console.error("Error crítico procesando mensaje:", error);
            try {
                await sock.sendMessage(msg.key.remoteJid, { text: "¡Hola! Estoy experimentando un pequeño inconveniente técnico momentáneo, pero ya vuelvo a estar contigo." });
            } catch (innerErr) {
                console.error("No se pudo enviar mensaje de error al usuario:", innerErr);
            }
        }
    });
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot activo.\n');
});

server.listen(3000, () => {
    console.log('Servidor HTTP escuchando en el puerto 3000');
    startBot();
});