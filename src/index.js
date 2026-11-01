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

// Modelo estable de alta disponibilidad para evitar errores de saturación
const MODELO_ESTABLE = "gemini-3.5-flash-lite";

async function generarRespuestaIA(promptSistema, textoUsuario) {
    try {
        const modelo = genAI.getGenerativeModel({ model: MODELO_ESTABLE });
        const chat = modelo.startChat({ history: [{ role: "user", parts: [{ text: promptSistema }] }] });
        const result = await chat.sendMessage(textoUsuario);
        return result.response.text();
    } catch (error) {
        console.error(`[Gemini Error con ${MODELO_ESTABLE}]:`, error.message);
        throw error;
    }
}

const processedMessages = new Set();

async function generarLinkMercadoPago(idPedido, total, descripcion) {
    try {
        if (!mpClient) {
            return { initPoint: "link.mercadopago.cl/huevossantaestela", preferenceId: "ESTATICO" };
        }
        const preference = new Preference(mpClient);
        const result = await preference.create({
            body: {
                items: [{
                    id: idPedido,
                    title: descripcion,
                    quantity: 1,
                    unit_price: Number(total),
                    currency_id: 'CLP'
                }],
                external_reference: idPedido,
                back_urls: { success: "https://www.google.com", failure: "https://www.google.com" },
                auto_return: "approved"
            }
        });
        return { initPoint: result.init_point, preferenceId: result.id || 'DESC_MP' };
    } catch (error) {
        console.error("[Mercado Pago Error]:", error.message);
        return { initPoint: "link.mercadopago.cl/huevossantaestela", preferenceId: "ERROR_MP" };
    }
}

async function registrarPedidoSheets(idPedido, idProducto, cantidad, clienteJid, total, metodoPago, direccion, nombreCliente, telefonoContacto, linkPago, idPagoMP) {
    try {
        if (!URL_APPS_SCRIPT) return;
        let telefonoLimpidio = telefonoContacto ? String(telefonoContacto).replace(/\D/g, '') : clienteJid.split('@')[0].replace(/\D/g, '');
        if (telefonoLimpidio.length === 9 && telefonoLimpidio.startsWith('9')) telefonoLimpidio = '56' + telefonoLimpidio;
        
        await fetch(URL_APPS_SCRIPT, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idPedido, telefono: clienteJid.split('@')[0], cliente: clienteJid,
                nombreCliente: nombreCliente || 'Cliente WhatsApp',
                telefonoContacto: '+' + telefonoLimpidio,
                idProducto: idProducto || 'PROD-001',
                cantidad: parseInt(cantidad) || 1, total: parseInt(total) || 0,
                metodoPago: metodoPago || 'Por confirmar', direccion: direccion || 'Por confirmar',
                linkPago: linkPago || '', idPagoMP: idPagoMP || ''
            })
        });
    } catch (e) {
        console.error("[Sheets Error]:", e.message);
    }
}

async function obtenerDatosSheets() {
    try {
        if (!URL_APPS_SCRIPT) return { stock: [], clientes: {}, despachos: [], vendedores: [] };
        const res = await fetch(URL_APPS_SCRIPT, { redirect: 'follow' });
        const text = await res.text();
        const data = JSON.parse(text);
        console.log(`[Sheets Debug] Catálogo: ${data.stock?.length || 0} productos, Clientes: ${Object.keys(data.clientes || {}).length}, Zonas: ${data.despachos?.length || 0}`);
        return data;
    } catch (e) {
        console.error("[Sheets Error - Obtener Datos]:", e.message);
        return { stock: [], clientes: {}, despachos: [], vendedores: [] };
    }
}

async function notificarVendedores(sock, clienteInfo, comunaIngresada, listaVendedores) {
    const mensajeAlerta = `🚨 *NUEVA INCIDENCIA / DESPACHO FUERA DE ZONA* 🚨\n\n` +
                          `👤 *Cliente*: ${clienteInfo.nombre || 'Cliente WhatsApp'}\n` +
                          `📱 *Teléfono*: ${clienteInfo.telefono}\n` +
                          `📍 *Comuna ingresada*: ${comunaIngresada}\n` +
                          `⚠️ *Estado*: Requiere validación y posible cobro extra (Se usó referencia Stgo Sector 2).`;

    const vendedoresACotizar = (listaVendedores && listaVendedores.length > 0) ? listaVendedores : [
        { nombre: 'Lorenzo Macaya', telefono: '56982295850' },
        { nombre: 'Hugo Silva', telefono: '56990011731' }
    ];

    for (let v of vendedoresACotizar) {
        try {
            const telLimpio = String(v.telefono || '').replace(/\D/g, '');
            if (telLimpio) {
                await sock.sendMessage(telLimpio + '@s.whatsapp.net', { text: mensajeAlerta });
            }
        } catch (errVendedor) {
            console.error(`[Error Alerta Vendedor]`, errVendedor.message);
        }
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
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

            // Obtener datos frescos del Excel
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const infoClientes = datosSheet.clientes || {};
            const lugaresDespacho = datosSheet.despachos || [];
            const listaVendedoresSheets = datosSheet.vendedores || [];

            const telefonoLimpio = currentJid.split('@')[0].replace(/\D/g, '');
            let clienteConocido = null;

            // Reconocimiento robusto del cliente
            for (let telKey in infoClientes) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || telefonoLimpio.endsWith(keyClean) || keyClean.endsWith(telefonoLimpio)) {
                    clienteConocido = infoClientes[telKey];
                    break;
                }
            }

            const textoLimpio = textMessage.trim();
            if (!clienteConocido && /^\d{1,4}$/.test(textoLimpio)) {
                for (let tel in infoClientes) {
                    if (infoClientes[tel].codigo === textoLimpio || infoClientes[tel].id === textoLimpio) {
                        clienteConocido = infoClientes[tel];
                        break;
                    }
                }
            }

            let promptSistema = `Eres el asistente virtual experto y amable de "Huevos Santa Estela".
            
            CATÁLOGO DE PRODUCTOS (Usa estrictamente Tipo de Huevo, Formato y el Valor correspondiente a la zona del cliente. ESTÁ PROHIBIDO mencionar stock o disponibilidad):
            ${JSON.stringify(catalogo, null, 2)}

            ZONAS Y PRECIOS:
            ${JSON.stringify(lugaresDespacho, null, 2)}
            
            DATOS DEL CLIENTE DETECTADO: ${JSON.stringify(clienteConocido || { telefono: telefonoLimpio, nuevo: true })};

            INSTRUCCIONES CLAVE:
            1. RECONOCIMIENTO: Si en "DATOS DEL CLIENTE DETECTADO" aparece un nombre o dirección registrada (no dice "nuevo: true"), salúdalo por su nombre y recuérdale su ubicación. Si es nuevo, salúdalo cordialmente y pídele amablemente su nombre y comuna.
            2. FORMATO DE PRECIOS: Muestra SOLAMENTE el Tipo de Huevo, el Formato y el Valor exacto según su zona (Linares, Santiago Sector 1 o Santiago Sector 2). NUNCA menciones la palabra stock.
            3. ZONAS Y ALERTAS: Si es de una comuna fuera de rango (ej. San Bernardo), explícale que se aplica tarifa de referencia de Santiago Sector 2 y que se validará con el equipo.
            4. CIERRE DE PEDIDO: Cuando tengas producto, cantidad, método de pago ("Mercado Pago" o "Contra Entrega") y dirección, agrega al final el JSON exacto:
            [REGISTRAR_PEDIDO:{"idPedido":"PED-${Math.floor(1000 + Math.random() * 9000)}","idProducto":"<ID>","cantidad":<NUM>,"total":<NUM>,"metodoPago":"<METODO>","direccion":"<DIRECCION>","nombreCliente":"<NOMBRE>","telefonoContacto":"<TEL>"}]
            `;

            const respuestaIA = await generarRespuestaIA(promptSistema, textMessage);

            const matchPedido = respuestaIA.match(/\[REGISTRAR_PEDIDO:(.*?)\]/);
            if (matchPedido) {
                try {
                    const datosPedido = JSON.parse(matchPedido[1]);
                    const direccionLower = datosPedido.direccion.toLowerCase();
                    const esFueraDeZona = !lugaresDespacho.some(d => direccionLower.includes(d.comuna?.toLowerCase()));

                    if (esFueraDeZona) {
                        await notificarVendedores(sock, { nombre: datosPedido.nombreCliente, telefono: datosPedido.telefonoContacto || telefonoLimpio }, datosPedido.direccion, listaVendedoresSheets);
                    }

                    let linkPagoGenerado = "";
                    let idPagoMPGenerado = "EFECTIVO/CONTRA_ENTREGA";
                    if (datosPedido.metodoPago.toLowerCase().includes('mercado')) {
                        const datosMp = await generarLinkMercadoPago(datosPedido.idPedido, datosPedido.total, `Huevos Santa Estela (${datosPedido.idProducto})`);
                        linkPagoGenerado = datosMp.initPoint;
                        idPagoMPGenerado = datosMp.preferenceId;
                    }

                    await registrarPedidoSheets(datosPedido.idPedido, datosPedido.idProducto, datosPedido.cantidad, currentJid, datosPedido.total, datosPedido.metodoPago, datosPedido.direccion, datosPedido.nombreCliente, datosPedido.telefonoContacto, linkPagoGenerado, idPagoMPGenerado);

                    let respuestaLimpia = respuestaIA.replace(/\[REGISTRAR_PEDIDO:.*?\]/, '');
                    if (linkPagoGenerado) respuestaLimpia += `\n\n💳 *Enlace de Pago Mercado Pago ($${datosPedido.total} CLP):*\n${linkPagoGenerado}`;
                    if (esFueraDeZona) respuestaLimpia += `\n\n⚠️ *Nota:* Como tu comuna requiere validación especial, hemos notificado a nuestros vendedores.`;

                    await sock.sendMessage(currentJid, { text: respuestaLimpia });
                    return;
                } catch (errJson) {
                    console.error("[Error Parseando Pedido]:", errJson.message);
                }
            }

            await sock.sendMessage(currentJid, { text: respuestaIA });

        } catch (error) {
            console.error("Error procesando mensaje:", error);
        }
    });
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Huevos Santa Estela activo y operando.\n');
});

server.listen(3000, () => {
    console.log('Servidor HTTP escuchando en el puerto 3000');
    startBot();
});