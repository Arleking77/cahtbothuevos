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
const MODELO_ESTABLE = "gemini-3.5-flash-lite";

// Memoria temporal robusta para mantener el contexto y sesión por usuario
const sesionesUsuarios = {};

async function generarRespuestaIA(historialChat, textoUsuario) {
    try {
        const modelo = genAI.getGenerativeModel({ model: MODELO_ESTABLE });
        const chat = modelo.startChat({ history: historialChat });
        const result = await chat.sendMessage(textoUsuario);
        return result.response.text();
    } catch (error) {
        console.error(`[Gemini Error]:`, error.message);
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
        const listaZonas = data.despachos || data.zonas || [];
        
        console.log(`[Sheets Debug] Catálogo: ${data.stock?.length || 0} productos, Clientes: ${Object.keys(data.clientes || {}).length}, Zonas: ${listaZonas.length}`);
        
        return {
            stock: data.stock || [],
            clientes: data.clientes || {},
            despachos: listaZonas,
            vendedores: data.vendedores || []
        };
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

            if (!sesionesUsuarios[currentJid]) {
                sesionesUsuarios[currentJid] = {
                    nombre: null,
                    comuna: null,
                    zona: null,
                    historial: []
                };
            }
            const sesion = sesionesUsuarios[currentJid];

            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const infoClientes = datosSheet.clientes || {};
            const lugaresDespacho = datosSheet.despachos || [];
            const listaVendedoresSheets = datosSheet.vendedores || [];

            const telefonoLimpio = currentJid.split('@')[0].replace(/\D/g, '');
            let clienteConocido = null;

            const telSufijo = telefonoLimpio.slice(-8);
            for (let telKey in infoClientes) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    clienteConocido = infoClientes[telKey];
                    break;
                }
            }

            if (clienteConocido) {
                if (!sesion.nombre) sesion.nombre = clienteConocido.nombre;
                if (!sesion.comuna) sesion.comuna = clienteConocido.comuna || clienteConocido.direccion;
            }

            const textoLimpio = textMessage.trim();

            for (let d of lugaresDespacho) {
                if (d.comuna && textoLimpio.toLowerCase().includes(d.comuna.toLowerCase())) {
                    sesion.comuna = d.comuna;
                    sesion.zona = d.zona;
                    break;
                }
            }

            if (!sesion.nombre && !/^\d+$/.test(textoLimpio) && textoLimpio.length > 2 && !textoLimpio.toLowerCase().includes('hola')) {
                const partes = textoLimpio.split(',');
                if (partes.length > 1) {
                    sesion.nombre = partes[0].trim();
                    const posibleComuna = partes[1].trim();
                    for (let d of lugaresDespacho) {
                        if (d.comuna && posibleComuna.toLowerCase().includes(d.comuna.toLowerCase())) {
                            sesion.comuna = d.comuna;
                            sesion.zona = d.zona;
                        }
                    }
                } else if (!sesion.nombre) {
                    sesion.nombre = textoLimpio;
                }
            }

            let zonaAplicada = sesion.zona || "Santiago Sector 1";
            if (sesion.comuna) {
                for (let d of lugaresDespacho) {
                    if (d.comuna && sesion.comuna.toLowerCase().includes(d.comuna.toLowerCase())) {
                        zonaAplicada = d.zona || "Santiago Sector 1";
                        break;
                    }
                }
            }

            let catalogoTextoPrecios = "";
            catalogo.forEach(p => {
                let precioZona = p.precio;
                const zonaLower = zonaAplicada.toLowerCase();
                
                if (zonaLower.includes('linares')) {
                    precioZona = p.precioLinares || p.precio;
                } else if (zonaLower.includes('sector 2')) {
                    precioZona = p.precioStgo2 || p.precio + 500;
                } else {
                    precioZona = p.precioStgo1 || p.precio;
                }
                
                catalogoTextoPrecios += `- ID: ${p.id} | ${p.categoria} (${p.descripcion}) | Precio oficial para ${zonaAplicada}: $${precioZona} CLP\n`;
            });

            let promptSistema = `Eres el asistente virtual experto, directo y amable de "Huevos Santa Estela".
            
            DATOS ACTUALES DEL CLIENTE:
            - Nombre: ${sesion.nombre || (clienteConocido ? clienteConocido.nombre : 'Por definir')}
            - Comuna: ${sesion.comuna || (clienteConocido ? clienteConocido.comuna : 'Por definir')}
            - Zona de Despacho: ${zonaAplicada}

            CATÁLOGO Y PRECIOS OFICIALES PARA SU ZONA (${zonaAplicada}):
            ${catalogoTextoPrecios}

            INSTRUCCIONES CLAVE E INQUEBRANTABLES:
            1. MEMORIA DE CLIENTE: Si el cliente ya tiene nombre y comuna definidos arriba, salúdalo por su nombre y recuérdale su comuna. ¡ESTÁ PROHIBIDO volver a pedirle el nombre o la comuna si ya los tenemos en los datos actuales!
            2. PRECIOS OBLIGATORIOS: Si el cliente pregunta por precios, valores o catálogo, DEBES listar los productos con sus precios exactos en pesos chilenos ($ CLP) extraídos estrictamente de la lista de precios oficial detallada arriba para su zona. Nunca omitas los precios. Prohibido mencionar stock.
            3. CIERRE DE PEDIDO: Cuando tengas producto, cantidad, método de pago y dirección, genera al final el JSON exacto:
            [REGISTRAR_PEDIDO:{"idPedido":"PED-${Math.floor(1000 + Math.random() * 9000)}","idProducto":"<ID>","cantidad":<NUM>,"total":<NUM>,"metodoPago":"<METODO>","direccion":"<DIRECCION>","nombreCliente":"<NOMBRE>","telefonoContacto":"<TEL>"}]
            `;

            if (sesion.historial.length === 0) {
                sesion.historial.push({ role: "user", parts: [{ text: promptSistema }] });
                sesion.historial.push({ role: "model", parts: [{ text: "Entendido. Operaré estrictamente con estos datos y precios por zona." }] });
            }

            const respuestaIA = await generarRespuestaIA(sesion.historial, textMessage);

            sesion.historial.push({ role: "user", parts: [{ text: textMessage }] });
            sesion.historial.push({ role: "model", parts: [{ text: respuestaIA }] });
            if (sesion.historial.length > 15) sesion.historial.splice(2, 2);

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