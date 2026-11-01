import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import dotenv from 'dotenv';
import http from 'http';
import fetch from 'node-fetch';

dotenv.config();

const URL_APPS_SCRIPT = process.env.URL_APPS_SCRIPT;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// Inicializar Mercado Pago si hay token
let mpClient = null;
if (MP_ACCESS_TOKEN) {
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    console.log("[Mercado Pago] SDK inicializado correctamente.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Caché de mensajes para evitar duplicados en WhatsApp
const processedMessages = new Set();
// Control de temporizadores de inactividad por cliente (JID)
const userTimers = new Map();

// Contactos de Vendedores para alertas automáticas de despachos fuera de zona
const VENDEDORES = [
    { nombre: 'Lorenzo Macaya', telefono: '56982295850' },
    { nombre: 'Hugo Silva', telefono: '56990011731' }
];

// A. Generar link dinámico de Checkout Pro en Mercado Pago
async function generarLinkMercadoPago(idPedido, total, descripcion) {
    try {
        if (!mpClient) {
            console.log("[Mercado Pago] No hay MP_ACCESS_TOKEN. Usando link estático.");
            return { initPoint: "link.mercadopago.cl/huevossantaestela", preferenceId: "ESTATICO" };
        }
        const preference = new Preference(mpClient);
        const result = await preference.create({
            body: {
                items: [
                    {
                        id: idPedido,
                        title: descripcion,
                        quantity: 1,
                        unit_price: Number(total),
                        currency_id: 'CLP'
                    }
                ],
                external_reference: idPedido,
                back_urls: {
                    success: "https://www.google.com",
                    failure: "https://www.google.com"
                },
                auto_return: "approved"
            }
        });
        console.log(`[Mercado Pago] ✅ Link generado para ${idPedido} (ID Pref: ${result.id}): ${result.init_point}`);
        return { 
            initPoint: result.init_point, 
            preferenceId: result.id || 'DESC_MP' 
        };
    } catch (error) {
        console.error("[Mercado Pago Error] Error al crear preferencia:", error.message);
        return { initPoint: "link.mercadopago.cl/huevossantaestela", preferenceId: "ERROR_MP" };
    }
}

// B. Registrar un nuevo pedido en Google Sheets
async function registrarPedidoSheets(idPedido, idProducto, cantidad, clienteJid, total, metodoPago, direccion, nombreCliente, telefonoContacto, linkPago, idPagoMP) {
    try {
        if (!URL_APPS_SCRIPT) return;
        
        let telefonoLimpidio = telefonoContacto ? String(telefonoContacto).replace(/\D/g, '') : '';
        if (!telefonoLimpidio || telefonoLimpidio.length < 8) {
            telefonoLimpidio = clienteJid.split('@')[0].replace(/\D/g, '');
        }
        if (telefonoLimpidio.length === 9 && telefonoLimpidio.startsWith('9')) {
            telefonoLimpidio = '56' + telefonoLimpidio;
        }
        const keyCliente = clienteJid.split('@')[0];
        console.log(`[Google Sheets] Guardando pedido ${idPedido} con ID MP: ${idPagoMP}...`);
        const res = await fetch(URL_APPS_SCRIPT, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idPedido: idPedido,
                telefono: keyCliente,
                cliente: clienteJid,
                nombreCliente: nombreCliente || 'Cliente WhatsApp',
                telefonoContacto: '+' + telefonoLimpidio,
                idProducto: idProducto || 'PROD-001',
                cantidad: parseInt(cantidad) || 1,
                total: parseInt(total) || 0,
                metodoPago: metodoPago || 'Por confirmar',
                direccion: direccion || 'Por confirmar',
                linkPago: linkPago || '',
                idPagoMP: idPagoMP || ''
            })
        });
        const respText = await res.text();
        console.log(`[Google Sheets] ✅ Respuesta del servidor: ${respText}`);
    } catch (e) {
        console.error("[Sheets Error] Error al guardar pedido en Sheets:", e.message);
    }
}

// C. Obtener datos desde Google Sheets (Inventario, Clientes y Despachos)
async function obtenerDatosSheets() {
    try {
        if (!URL_APPS_SCRIPT) return { stock: [], clientes: {}, despachos: [] };
        const res = await fetch(URL_APPS_SCRIPT, { redirect: 'follow' });
        const text = await res.text();
        return JSON.parse(text);
    } catch (e) {
        console.error("[Sheets Error] Error al consultar Google Sheets:", e.message);
        return { stock: [], clientes: {}, despachos: [] };
    }
}

// D. Enviar notificación automática a los vendedores ante incidencias de despacho fuera de zona
async function notificarVendedores(sock, clienteInfo, comunaIngresada) {
    const mensajeAlerta = `🚨 *NUEVA INCIDENCIA / DESPACHO FUERA DE ZONA* 🚨\n\n` +
                          `👤 *Cliente*: ${clienteInfo.nombre || 'Cliente WhatsApp'}\n` +
                          `📱 *Teléfono*: ${clienteInfo.telefono}\n` +
                          `📍 *Comuna ingresada*: ${comunaIngresada}\n` +
                          `⚠️ *Estado*: Requiere validación de factibilidad y posible cobro extra por despacho (Se usó referencia Stgo Sector 2).`;

    for (let v of VENDEDORES) {
        const jidVendedor = v.telefono + '@s.whatsapp.net';
        try {
            await sock.sendMessage(jidVendedor, { text: mensajeAlerta });
            console.log(`[Alerta Vendedor] Notificación enviada a ${v.nombre} (${v.telefono})`);
        } catch (errVendedor) {
            console.error(`[Error Alerta Vendedor] No se pudo enviar a ${v.nombre}:`, errVendedor.message);
        }
    }
}

// E. Inicializar el Bot de WhatsApp con Baileys
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando...', shouldReconnect);
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

            console.log(`Mensaje recibido de ${currentJid}: ${textMessage}`);

            // --- GESTIÓN DE INACTIVIDAD (5 MINUTOS) ---
            if (userTimers.has(currentJid)) {
                clearTimeout(userTimers.get(currentJid));
            }
            const timerId = setTimeout(async () => {
                try {
                    const mensajeCierre = `Quedó anotado el pedido, estamos confirmando cosas antes de enviarlo. Gracias por comprar con Santa Estela 🥚✨`;
                    await sock.sendMessage(currentJid, { text: mensajeCierre });
                    console.log(`[Cierre Automático por Inactividad] Mensaje enviado a ${currentJid}`);
                    userTimers.delete(currentJid);
                } catch (errCierre) {
                    console.error("[Error Cierre Automático]:", errCierre.message);
                }
            }, 5 * 60 * 1000);
            userTimers.set(currentJid, timerId);

            // Consultar datos actualizados de Google Sheets (Inventario, Clientes y Despachos)
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const infoClientes = datosSheet.clientes || {};
            const lugaresDespacho = datosSheet.despachos || [];

            const telefonoLimpio = currentJid.split('@')[0];
            
            // BÚSQUEDA INTELIGENTE: Identificar al cliente por Teléfono o por Código Corto (ej: "045")
            let clienteConocido = infoClientes[telefonoLimpio] || null;
            const textoLimpio = textMessage.trim();

            if (!clienteConocido && /^\d{1,4}$/.test(textoLimpio)) {
                // Buscar si el mensaje corresponde a un código de cliente en la base
                const codigoBuscado = textoLimpio;
                for (let tel in infoClientes) {
                    if (infoClientes[tel].codigo === codigoBuscado || infoClientes[tel].id === codigoBuscado) {
                        clienteConocido = infoClientes[tel];
                        break;
                    }
                }
            }

            let promptSistema = `Eres el asistente virtual experto y amable de "Huevos Santa Estela", un negocio familiar de venta de huevos frescos y subproductos en Chile.
            
            Catálogo actual de productos (incluyendo precios por zona - Linares, Santiago Sector 1, Santiago Sector 2):
            ${JSON.stringify(catalogo, null, 2)}

            Zonas y reglas de despacho disponibles:
            ${JSON.stringify(lugaresDespacho, null, 2)}
            
            Datos del cliente detectados: ${JSON.stringify(clienteConocido || { telefono: telefonoLimpio, nuevo: true })};

            Reglas de negocio clave para despachos:
            1. Si el cliente ya está registrado y conocemos su comuna, indícale de inmediato los precios correspondientes a su zona (Linares, Santiago Sector 1 o Santiago Sector 2).
            2. Si es cliente nuevo, pregúntale su comuna para asignarle el precio y tarifa de despacho exacta.
            3. Si la comuna del cliente no está registrada o está fuera de cobertura habitual, utiliza por referencia los precios más altos de Santiago Sector 2, adviértele que puede tener un cobro extra por despacho y que se validará con el administrador. Al detectar esto, asegúrate de activar la validación para notificar a los vendedores.
            
            Tu objetivo es guiar al cliente, tomar su pedido y cuando tengas claros el producto, cantidad, método de pago ("Mercado Pago" o "Contra Entrega") y dirección/comuna de despacho, debes incluir obligatoriamente al final de tu respuesta un bloque con este formato JSON estricto:
            [REGISTRAR_PEDIDO:{"idPedido":"PED-${Math.floor(1000 + Math.random() * 9000)}","idProducto":"<ID>","cantidad":<NUM>,"total":<NUM>,"metodoPago":"<METODO>","direccion":"<DIRECCION>","nombreCliente":"<NOMBRE>","telefonoContacto":"<TEL>"}]
            `;

            const chat = model.startChat({
                history: [
                    { role: "user", parts: [{ text: promptSistema }] }
                ]
            });

            const result = await chat.sendMessage(textMessage);
            const respuestaIA = result.response.text();

            // Detectar si la IA generó el tag de registro de pedido
            const matchPedido = respuestaIA.match(/\[REGISTRAR_PEDIDO:(.*?)\]/);
            if (matchPedido) {
                try {
                    const jsonString = matchPedido[1];
                    const datosPedido = JSON.parse(jsonString);

                    // Verificar si la dirección/comuna requiere alerta a los vendedores
                    // (si la comuna ingresada no es de la lista regular)
                    const direccionLower = datosPedido.direccion.toLowerCase();
                    const esFueraDeZona = !lugaresDespacho.some(d => direccionLower.includes(d.comuna?.toLowerCase()));

                    if (esFueraDeZona) {
                        await notificarVendedores(sock, {
                            nombre: datosPedido.nombreCliente,
                            telefono: datosPedido.telefonoContacto || telefonoLimpio
                        }, datosPedido.direccion);
                    }

                    let linkPagoGenerado = "";
                    let idPagoMPGenerado = "EFECTIVO/CONTRA_ENTREGA";
                    if (datosPedido.metodoPago.toLowerCase().includes('mercado')) {
                        const datosMp = await generarLinkMercadoPago(
                            datosPedido.idPedido,
                            datosPedido.total,
                            `Huevos Santa Estela (${datosPedido.idProducto})`
                        );
                        linkPagoGenerado = datosMp.initPoint;
                        idPagoMPGenerado = datosMp.preferenceId;
                    }

                    await registrarPedidoSheets(
                        datosPedido.idPedido,
                        datosPedido.idProducto,
                        datosPedido.cantidad,
                        currentJid,
                        datosPedido.total,
                        datosPedido.metodoPago,
                        datosPedido.direccion,
                        datosPedido.nombreCliente,
                        datosPedido.telefonoContacto,
                        linkPagoGenerado,
                        idPagoMPGenerado
                    );

                    let respuestaLimpia = respuestaIA.replace(/\[REGISTRAR_PEDIDO:.*?\]/, '');
                    if (linkPagoGenerado) {
                        respuestaLimpia += `\n\n💳 *Enlace de Pago Mercado Pago ($${datosPedido.total} CLP):*\n${linkPagoGenerado}`;
                    }
                    if (esFueraDeZona) {
                        respuestaLimpia += `\n\n⚠️ *Nota:* Como tu comuna está fuera de nuestra zona de ruta regular, hemos notificado a nuestros vendedores para validar el despacho y confirmar si aplica un cobro extra.`;
                    }

                    await sock.sendMessage(currentJid, { text: respuestaLimpia });
                    console.log("Respuesta enviada con éxito a WhatsApp");
                    return;
                } catch (errJson) {
                    console.error("[Error Parseando Pedido]:", errJson.message);
                }
            }

            await sock.sendMessage(currentJid, { text: respuestaIA });
            console.log("Respuesta enviada con éxito a WhatsApp");

        } catch (error) {
            console.error("Error procesando mensaje:", error);
        }
    });
}

// Servidor HTTP simple de soporte
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Huevos Santa Estela activo y operando.\n');
});

server.listen(3000, () => {
    console.log('Servidor HTTP escuchando en el puerto 3000');
    startBot();
});