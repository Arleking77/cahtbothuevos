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
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    console.log("[Mercado Pago] SDK inicializado correctamente.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODELO_SEGURO = "gemini-1.5-flash";

// Mapa para mantener las sesiones activas de chat por usuario (evita que pierdan la memoria)
const sesionesChat = {};
const processedMessages = new Set();

async function obtenerDatosSheets() {
    try {
        if (!URL_APPS_SCRIPT) return { stock: [], clientes: {}, despachos: [] };
        const res = await fetch(URL_APPS_SCRIPT, { redirect: 'follow' });
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

            // Obtenemos los datos actualizados de Google Sheets
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const clientesMap = datosSheet.clientes || {};
            const despachos = datosSheet.despachos || [];

            // Búsqueda robusta del cliente por teléfono
            let usuario = null;
            for (let telKey in clientesMap) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    usuario = clientesMap[telKey];
                    break;
                }
            }

            // Si no está registrado, valores por defecto
            if (!usuario) {
                usuario = { 
                    nombre: "Pablo", 
                    comuna: "San Bernardo", 
                    zona: "Santiago Sector 1" 
                };
            }

            // Determinar qué columna de precio usar según la zona del cliente
            let zonaCliente = (usuario.zona || "").toLowerCase();
            let catalogoTexto = "";
            
            catalogo.forEach(p => {
                let precioFinal = p.precioStgo1 || p.precioLinares || 6000; // Valor por defecto
                
                if (zonaCliente.includes("sector 2")) {
                    precioFinal = p.precioStgo2 || precioFinal;
                } else if (zonaCliente.includes("linares")) {
                    precioFinal = p.precioLinares || precioFinal;
                } else {
                    // Por defecto Sector 1 o Santiago
                    precioFinal = p.precioStgo1 || precioFinal;
                }

                catalogoTexto += `- [ID: ${p.id}] ${p.categoria} (${p.descripcion} - ${p.formato}) -> Precio para ${usuario.zona}: $${precioFinal} CLP\n`;
            });

            // Configurar sesión de chat persistente para que no pierda la memoria
            if (!sesionesChat[telefonoLimpio]) {
                const model = genAI.getGenerativeModel({ model: MODELO_SEGURO });
                
                let promptSistema = `Eres el asistente virtual experto y directo de "Huevos Santa Estela".
                
                DATOS DEL CLIENTE:
                - Nombre: ${usuario.nombre}
                - Comuna: ${usuario.comuna}
                - Zona de Despacho: ${usuario.zona}
                - Teléfono: ${telefonoLimpio}

                CATÁLOGO Y PRECIOS OFICIALES PARA SU ZONA:
                ${catalogoTexto}

                INSTRUCCIONES ESTRICTAS:
                1. Saluda a ${usuario.nombre} por su nombre y recuérdale que estás atento a su pedido para ${usuario.comuna}.
                2. Usa ÚNICAMENTE los precios indicados para su zona en el catálogo de arriba. No inventes precios ni digas "tarifa base".
                3. Jamás vuelvas a preguntar el nombre ni la comuna, ya los tienes registrados.
                `;

                sesionesChat[telefonoLimpio] = model.startChat({
                    history: [
                        { role: "user", parts: [{ text: "Hola, inicia sistema con estos datos." }] },
                        { role: "model", parts: [{ text: `¡Hola ${usuario.nombre}! Qué gusto saludarte de nuevo. Veo que nos escribes desde ${usuario.comuna} (${usuario.zona}). ¿En qué te puedo ayudar hoy con nuestros huevos frescos?` }] }
                    ]
                });
            }

            const chatSession = sesionesChat[telefonoLimpio];
            const resultado = await chatSession.sendMessage(textMessage);
            const respuestaIA = resultado.response.text();

            await sock.sendMessage(currentJid, { text: respuestaIA });

        } catch (error) {
            console.error("Error procesando mensaje:", error);
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