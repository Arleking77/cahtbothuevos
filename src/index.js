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
// Usamos el modelo flash estándar más compatible
const MODELO_SEGURO = "gemini-1.5-flash";

const memoriaUsuarios = {};

async function generarRespuesta(promptSistema, textoUsuario) {
    try {
        const modelo = genAI.getGenerativeModel({ model: MODELO_SEGURO });
        const resultado = await modelo.generateContent(`${promptSistema}\n\nMensaje del cliente: "${textoUsuario}"`);
        return resultado.response.text();
    } catch (error) {
        console.error(`[Gemini Error]:`, error.message);
        return "¡Hola! Estoy experimentando un pequeño problema técnico de conexión en este momento, pero ya te atiendo con los precios.";
    }
}

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

            if (!memoriaUsuarios[telefonoLimpio]) {
                memoriaUsuarios[telefonoLimpio] = { nombre: "Pablo Macaya", comuna: "San Bernardo", zona: "Santiago Sector 1" };
            }
            const usuario = memoriaUsuarios[telefonoLimpio];

            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const lugaresDespacho = datosSheet.despachos || [];

            let catalogoTexto = "";
            catalogo.forEach(p => {
                let precioZona = p.precioStgo1 || p.precio || 6000;
                catalogoTexto += `- [ID: ${p.id}] ${p.categoria} (${p.descripcion}) -> Precio oficial: $${precioZona} CLP\n`;
            });

            let promptSistema = `Eres el asistente virtual experto y directo de "Huevos Santa Estela".
            
            DATOS DEL CLIENTE:
            - Nombre: ${usuario.nombre}
            - Comuna: ${usuario.comuna}
            - Zona: ${usuario.zona}

            CATÁLOGO Y PRECIOS OFICIALES:
            ${catalogoTexto}

            INSTRUCCIONES:
            1. Saluda a ${usuario.nombre} por su nombre y recuérdale que estás atento a su pedido para ${usuario.comuna}.
            2. Muestra los precios exactos del catálogo anterior de forma clara y directa.
            3. NUNCA pidas el nombre ni la comuna, ya los tenemos registrados arriba.
            `;

            const respuestaIA = await generarRespuesta(promptSistema, textMessage);
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