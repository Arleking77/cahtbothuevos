JavaScript
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
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
const estadoConversacion = {}; // Control de estado por pasos para evitar amnesia
const processedMessages = new Set();

async function obtenerDatosSheets() {
    try {
        if (!URL_APPS_SCRIPT) return { stock: [], clientes: {}, despachos: [] };
        const res = await fetch(URL_APPS_SCRIPT, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const text = await res.text();
        const data = JSON.parse(text);
        return {
            stock: data.stock || [],
            clientes: data.clientes || {},
            despachos: data.despachos || []
        };
    } catch (e) {
        console.error("[Sheets Error]:", e.message);
        return { stock: [], clientes: {}, despachos: [] };
    }
}

async function guardarPedidoEnSheets(pedidoData) {
    try {
        if (!URL_APPS_SCRIPT) return;
        await fetch(URL_APPS_SCRIPT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pedidoData)
        });
        console.log("[Sheets] Pedido guardado exitosamente.");
    } catch (e) {
        console.error("[Sheets POST Error]:", e.message);
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

            // Obtener datos de Google Sheets
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const clientesMap = datosSheet.clientes || {};
            const despachos = datosSheet.despachos || [];

            // Buscar cliente en el Sheet
            let usuarioRegistrado = null;
            for (let telKey in clientesMap) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    usuarioRegistrado = clientesMap[telKey];
                    break;
                }
            }

            // Inicializar estado temporal si no existe
            if (!estadoConversacion[telefonoLimpio]) {
                estadoConversacion[telefonoLimpio] = {
                    nombre: usuarioRegistrado ? usuarioRegistrado.nombre : null,
                    comuna: usuarioRegistrado ? usuarioRegistrado.comuna : null,
                    direccion: usuarioRegistrado ? usuarioRegistrado.direccion : null,
                    zona: "Santiago Sector 1",
                    paso: usuarioRegistrado ? "MENU" : "PIDIENDO_NOMBRE"
                };
            }
            let est = estadoConversacion[telefonoLimpio];

            // Si el cliente responde y nos falta nombre o comuna, intentamos capturarlo del mensaje
            if (!est.nombre || est.paso === "PIDIENDO_NOMBRE") {
                est.nombre = textMessage.trim();
                est.paso = "PIDIENDO_COMUNA";
                await sock.sendMessage(currentJid, { text: `¡Mucho gusto, ${est.nombre}! ¿De qué comuna nos escribes para indicarte los precios y tarifas de despacho?` });
                return;
            } else if (!est.comuna || est.paso === "PIDIENDO_COMUNA") {
                est.comuna = textMessage.trim();
                
                // Buscar zona según la comuna en los despachos
                let zonaEncontrada = "Santiago Sector 1";
                for (let d of despachos) {
                    if (d.comuna.toLowerCase() === est.comuna.toLowerCase()) {
                        zonaEncontrada = d.zona;
                        break;
                    }
                }
                est.zona = zonaEncontrada;
                est.paso = "MENU";
            }

            // Mapear precios según la zona del cliente
            let zonaCliente = (est.zona || "").toLowerCase();
            let catalogoTexto = "";
            let mapaPrecios = {};

            catalogo.forEach(p => {
                let precioFinal = p.precioStgo1 || p.precioLinares || 6000;
                if (zonaCliente.includes("sector 2")) {
                    precioFinal = p.precioStgo2 || precioFinal;
                } else if (zonaCliente.includes("linares")) {
                    precioFinal = p.precioLinares || precioFinal;
                } else {
                    precioFinal = p.precioStgo1 || precioFinal;
                }
                mapaPrecios[p.id] = { descripcion: `${p.categoria} (${p.formato})`, precio: precioFinal };
                catalogoTexto += `- [ID: ${p.id}] ${p.categoria} (${p.descripcion} - ${p.formato}) -> Precio: $${precioFinal} CLP\n`;
            });

            // GESTIÓN DE SESIÓN DE CHAT CON GEMINI
            if (!sesionesChat[telefonoLimpio]) {
                const model = genAI.getGenerativeModel({ model: MODELO_SEGURO });
                
                let promptSistema = `Eres el asistente virtual experto y amable de "Huevos Santa Estela".
                
                DATOS DEL CLIENTE:
                - Nombre: ${est.nombre}
                - Comuna: ${est.comuna}
                - Zona: ${est.zona}
                - Teléfono: ${telefonoLimpio}

                CATÁLOGO Y PRECIOS OFICIALES PARA SU ZONA:
                ${catalogoTexto}

                INSTRUCCIONES DE FLUJO:
                1. Ya conoces al cliente (${est.nombre} de ${est.comuna}). NUNCA vuelvas a pedir su nombre ni su comuna.
                2. Ayúdale a elegir sus productos, calcula los totales exactos usando los precios del catálogo de arriba.
                3. Cuando el cliente confirme qué producto y cantidad quiere, pídele su dirección exacta y su método de pago (Mercado Pago o Contra Entrega).
                `;

                sesionesChat[telefonoLimpio] = model.startChat({
                    history: [
                        { role: "user", parts: [{ text: "Configuración inicial." }] },
                        { role: "model", parts: [{ text: `Entendido. Atendiendo a ${est.nombre} de ${est.comuna} (${est.zona}).` }] }
                    ]
                });
            }

            const chatSession = sesionesChat[telefonoLimpio];
            const resultado = await chatSession.sendMessage(textMessage);
            let respuestaIA = resultado.response.text();

            // Detectar si el usuario confirmó un pedido (Ej: menciona un producto y cantidad)
            const textoLower = textMessage.toLowerCase();
            if (textoLower.includes("jumbo") || textoLower.includes("extra") || textoLower.includes("primera") || textoLower.includes("bandeja")) {
                // Seleccionar producto por defecto o buscar coincidencia básica (ej: PROD-001 para Jumbo)
                let prodSeleccionado = catalogo[0]; 
                let cantidad = 1;
                let matchCant = textMessage.match(/\d+/);
                if (matchCant) cantidad = parseInt(matchCant[0]);

                let totalCalculado = prodSeleccionado.precioStgo1 * cantidad;
                if (zonaCliente.includes("sector 2")) totalCalculado = prodSeleccionado.precioStgo2 * cantidad;

                // Crear enlace de Mercado Pago si mpClient está disponible
                let linkPagoFinal = "";
                if (mpClient) {
                    try {
                        const preference = new Preference(mpClient);
                        const prefResponse = await preference.create({
                            body: {
                                items: [{
                                    title: `${prodSeleccionado.categoria} x${cantidad}`,
                                    quantity: cantidad,
                                    unit_price: totalCalculado,
                                    currency_id: "CLP"
                                }],
                                external_reference: "PED-" + Math.floor(1000 + Math.random() * 9000)
                            }
                        });
                        linkPagoFinal = prefResponse.init_point;
                        respuestaIA += `\n\n🔗 *Link de pago seguro (Mercado Pago):* ${linkPagoFinal}`;
                    } catch (mpErr) {
                        console.error("[Mercado Pago Preference Error]:", mpErr.message);
                    }
                }

                // Guardar automáticamente el pedido en Google Sheets
                await guardarPedidoEnSheets({
                    idPedido: "PED-" + Math.floor(1000 + Math.random() * 9000),
                    nombreCliente: est.nombre,
                    telefono: telefonoLimpio,
                    idProducto: prodSeleccionado.id,
                    cantidad: cantidad,
                    total: totalCalculado,
                    metodoPago: "Mercado Pago",
                    comuna: est.comuna,
                    direccion: est.direccion || est.comuna,
                    linkPago: linkPagoFinal
                });
            }

            await sock.sendMessage(currentJid, { text: respuestaIA });

        } catch (error) {
            console.error("Error crítico procesando mensaje:", error);
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