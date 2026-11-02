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

// Memoria temporal robusta para mantener el contexto de la conversación por usuario
const sesionesUsuarios = {};

async function generarRespuestaIA(historialChat, textoUsuario) {
    try {
        const modelo = genAI.getGenerativeModel({ model: MODELO_ESTABLE });
        const chat = modelo.startChat({ history: historialChat });
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

function determinarZonaYPrecios(comunaCliente, lugaresDespacho, catalogoProductos) {
    if (!comunaCliente) return { zona: "Santiago Sector 1", tarifa: "Tarifa Base", listaPrecios: [] };
    
    const comunaNorm = comunaCliente.toLowerCase().trim();
    let zonaEncontrada = "Santiago Sector 1";
    let tarifaEncontrada = "Tarifa Base";

    for (let d of lugaresDespacho) {
        if (d.comuna && comunaNorm.includes(d.comuna.toLowerCase())) {
            zonaEncontrada = d.zona || "Santiago Sector 1";
            tarifaEncontrada = d.tarifa || "Tarifa Base";
            break;
        }
    }

    // Mapeamos los precios exactos según la zona detectada
    const listaPrecios = catalogoProductos.map(prod => {
        let precioFinal = prod.precio; // fallback
        const descLower = (prod.descripcion || prod.categoria || '').toLowerCase();
        
        // Asignación estricta según columnas de tu Excel de productos
        if (zonaEncontrada.toLowerCase().includes('linares')) {
            precioFinal = prod.precioLinares || prod.precio; 
        } else if (zonaEncontrada.toLowerCase().includes('sector 2')) {
            precioFinal = prod.precioStgo2 || prod.precio + 500;
        } else {
            precioFinal = prod.precioStgo1 || prod.precio;
        }

        return {
            id: prod.id,
            producto: `${prod.categoria} - ${prod.descripcion}`,
            precio: prod.precio // Estructura general
        };
    });

    return { zona: zonaEncontrada, tarifa: tarifaEncontrada };
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

            // Inicializar sesión persistente en memoria para el usuario si no existe
            if (!sesionesUsuarios[currentJid]) {
                sesionesUsuarios[currentJid] = {
                    nombre: null,
                    comuna: null,
                    zona: null,
                    historial: []
                };
            }
            const sesion = sesionesUsuarios[currentJid];

            // Obtener datos frescos del Excel
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const infoClientes = datosSheet.clientes || {};
            const lugaresDespacho = datosSheet.despachos || [];
            const listaVendedoresSheets = datosSheet.vendedores || [];

            const telefonoLimpio = currentJid.split('@')[0].replace(/\D/g, '');
            let clienteConocido = null;

            // Búsqueda robusta por sufijo de 8 u 9 dígitos (evita fallos de formato con prefijos de WA)
            const telSufijo = telefonoLimpio.slice(-8);
            for (let telKey in infoClientes) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    clienteConocido = infoClientes[telKey];
                    break;
                }
            }

            // Si se encontró en Excel, sincronizamos la sesión
            if (clienteConocido) {
                if (!sesion.nombre) sesion.nombre = clienteConocido.nombre;
                if (!sesion.comuna) sesion.comuna = clienteConocido.comuna;
            }

            // Intentar detectar comuna o nombre si el usuario lo escribe en el texto y no lo teníamos
            const textoLimpio = textMessage.trim();
            if (!sesion.comuna) {
                for (let d of lugaresDespacho) {
                    if (d.comuna && textoLimpio.toLowerCase().includes(d.comuna.toLowerCase())) {
                        sesion.comuna = d.comuna;
                        sesion.zona = d.zona;
                        break;
                    }
                }
            }
            if (!sesion.nombre && !/^\d+$/.test(textoLimpio) && textoLimpio.length > 2 && !textoLimpio.toLowerCase().includes('hola')) {
                // Si el mensaje parece un nombre o viene con coma (ej: "Pablo, San Bernardo")
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

            // Determinar zona y precios específicos formateados para inyectar al prompt
            let zonaAplicada = sesion.zona || "Santiago Sector 1";
            if (sesion.comuna) {
                for (let d of lugaresDespacho) {
                    if (d.comuna && sesion.comuna.toLowerCase().includes(d.comuna.toLowerCase())) {
                        zonaAplicada = d.zona || "Santiago Sector 1";
                        break;
                    }
                }
            }

            // Construir catálogo detallado con precios explícitos según la zona del cliente
            let catalogoTextoPrecios = "";
            catalogo.forEach(p => {
                // Seleccionar tarifa según zona
                let precioZona = p.precio;
                if (zonaAplicada.toLowerCase().includes('linares')) {
                    precioZona = p.precioLinares || p.precio;
                } else if (zonaAplicada.toLowerCase().includes('sector 2')) {
                    precioZona = p.precioStgo2 || p.precio + 500;
                } else {
                    precioZona = p.precioStgo1 || p.precio;
                }
                catalogoTextoPrecios += `- ID: ${p.id} | ${p.categoria} (${p.descripcion}) | Formato: ${p.gramaje || 'Bandeja'} | Precio para ${zonaAplicada}: $${precioZona} CLP\n`;
            });

            let promptSistema = `Eres el asistente virtual experto, directo y amable de "Huevos Santa Estela".
            
            INFORMACIÓN ACTUAL DEL CLIENTE:
            - Nombre: ${sesion.nombre || (clienteConocido ? clienteConocido.nombre : 'Desconocido')}
            - Comuna / Ubicación: ${sesion.comuna || (clienteConocido ? clienteConocido.comuna : 'Por definir')}
            - Zona de Despacho Asignada: ${zonaAplicada}

            LISTA DE PRECIOS OFICIALES PARA SU ZONA (${zonaAplicada}):
            ${catalogoTextoPrecios}

            INSTRUCCIONES ESTRICTAS:
            1. RECONOCIMIENTO: Si el cliente ya tiene nombre y comuna registrados en la información actual, salúdalo por su nombre y recuérdale su comuna. NUNCA le vuelvas a preguntar el nombre ni la comuna si ya los conoces.
            2. PRECIOS OBLIGATORIOS: Cuando el cliente pida precios, catálogo o información de productos, DEBES listar los productos con sus precios exactos en pesos chilenos ($ CLP) basados en la lista de precios oficial para su zona detallada arriba. ESTÁ PROHIBIDO omitir los precios o decir que no los tienes. PROHIBIDO mencionar stock o disponibilidad.
            3. ZONAS FUERA DE RANGO: Si la comuna es fuera de rango (ej. San Bernardo), recuérdale que se aplica la tarifa de referencia de Santiago Sector 2 validada con el equipo.
            4. CIERRE DE PEDIDO: Cuando tengas producto, cantidad, método de pago ("Mercado Pago" o "Contra Entrega") y dirección exacta, genera al final de tu respuesta el JSON exacto:
            [REGISTRAR_PEDIDO:{"idPedido":"PED-${Math.floor(1000 + Math.random() * 9000)}","idProducto":"<ID>","cantidad":<NUM>,"total":<NUM>,"metodoPago":"<METODO>","direccion":"<DIRECCION>","nombreCliente":"<NOMBRE>","telefonoContacto":"<TEL>"}]
            `;

            // Construir historial de chat para la IA manteniendo el system prompt como rol user/model inicial
            if (sesion.historial.length === 0) {
                sesion.historial.push({ role: "user", parts: [{ text: promptSistema }] });
                sesion.historial.push({ role: "model", parts: [{ text: "Entendido. Operaré estrictamente con estos datos de cliente, precios por zona e instrucciones." }] });
            }

            const respuestaIA = await generarRespuestaIA(sesion.historial, textMessage);

            // Guardar en el historial de la sesión
            sesion.historial.push({ role: "user", parts: [{ text: textMessage }] });
            sesion.historial.push({ role: "model", parts: [{ text: respuestaIA }] });
            if (sesion.historial.length > 15) sesion.historial.splice(2, 2); // Mantener liviano el historial

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