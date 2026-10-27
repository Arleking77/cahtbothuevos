import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MercadoPagoConfig, Preference } from 'mercadopago';

// ---------------------------------------------------------------------------
// 1. CONFIGURACIÓN Y CLIENTES EXTERNOS
// ---------------------------------------------------------------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const URL_APPS_SCRIPT = process.env.URL_APPS_SCRIPT ? process.env.URL_APPS_SCRIPT.trim() : null;
const mpClient = process.env.MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN.trim() }) : null;

// Memoria conversacional temporal por usuario (JID)
const historialChat = new Map();

function obtenerHistorial(jid) {
    if (!historialChat.has(jid)) historialChat.set(jid, []);
    return historialChat.get(jid);
}

function guardarMensaje(jid, role, text) {
    const historial = obtenerHistorial(jid);
    historial.push({ role, text });
    if (historial.length > 10) historial.shift(); // Mantiene los últimos 10 mensajes
}

// ---------------------------------------------------------------------------
// 2. SERVICIOS Y APIS (Google Sheets & Mercado Pago)
// ---------------------------------------------------------------------------

// A. Consultar base de datos unificada desde Google Sheets
async function obtenerDatosSheets() {
    try {
        if (!URL_APPS_SCRIPT) {
            console.error("[Sheets Error] No se configuró URL_APPS_SCRIPT en el archivo .env");
            return { stock: [], pedidos: [], clientes: {}, config: {}, vendedores: [], faq: [] };
        }

        const res = await fetch(URL_APPS_SCRIPT, { redirect: 'follow' });
        
        if (!res.ok) {
            console.error(`[Sheets Error] Estado HTTP ${res.status}: ${res.statusText}`);
            return { stock: [], pedidos: [], clientes: {}, config: {}, vendedores: [], faq: [] };
        }

        const data = await res.json();
        console.log("[Google Sheets] ✅ Datos JSON leídos con éxito desde Sheets.");
        return data;

    } catch (e) {
        console.error("[Sheets Error] Error al consultar Google Sheets:", e.message);
        return { stock: [], pedidos: [], clientes: {}, config: {}, vendedores: [], faq: [] };
    }
}

// B. Registrar un nuevo pedido y actualizar cliente en Sheets de forma limpia
async function registrarPedidoSheets(idPedido, idProducto, cantidad, clienteJid, total, metodoPago, direccion, nombreCliente, telefonoContacto, linkPago) {
    try {
        if (!URL_APPS_SCRIPT) return;
        
        // Limpiar el teléfono para extraer solo los números reales y evitar que se guarde mal
        let telefonoLimpidio = telefonoContacto ? String(telefonoContacto).replace(/\D/g, '') : '';
        if (!telefonoLimpidio || telefonoLimpidio.length < 8) {
            telefonoLimpidio = clienteJid.split('@')[0].replace(/\D/g, '');
        }
        // Asegurar formato chileno si viene sin código de país
        if (telefonoLimpidio.length === 9 && telefonoLimpidio.startsWith('9')) {
            telefonoLimpidio = '56' + telefonoLimpidio;
        }

        const keyCliente = clienteJid.split('@')[0];
        console.log(`[Google Sheets] Guardando pedido ${idPedido} para ${keyCliente} (Tel: ${telefonoLimpidio})...`);

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
                idProducto: idProducto || 'PROD-001', // Evita que quede estático o vacío
                cantidad: parseInt(cantidad) || 1,
                total: parseInt(total) || 0,
                metodoPago: metodoPago || 'Por confirmar',
                direccion: direccion || 'Por confirmar',
                linkPago: linkPago || ''
            })
        });

        const respText = await res.text();
        console.log(`[Google Sheets] ✅ Respuesta del servidor: ${respText}`);
    } catch (e) {
        console.error("[Sheets Error] Error al guardar pedido en Sheets:", e.message);
    }
}

// C. Generar link dinámico de Checkout Pro en Mercado Pago
async function generarLinkMercadoPago(idPedido, total, descripcion) {
    try {
        if (!mpClient) {
            console.log("[Mercado Pago] No hay MP_ACCESS_TOKEN. Usando link estático.");
            return "link.mercadopago.cl/huevossantaestela";
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

        console.log(`[Mercado Pago] ✅ Link generado para ${idPedido}: ${result.init_point}`);
        return result.init_point;
    } catch (error) {
        console.error("[Mercado Pago Error] Error al crear preferencia:", error.message);
        return "link.mercadopago.cl/huevossantaestela";
    }
}

// D. Reintentos resilientes para llamadas a la IA
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generarConReintentos(prompt, intentos = 3) {
    for (let i = 1; i <= intentos; i++) {
        try {
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            console.log(`[IA Warning] Intento ${i}/${intentos} falló (${error.status || '503'}). Reintentando en 2s...`);
            if (i === intentos) throw error;
            await esperar(2000);
        }
    }
}

// ---------------------------------------------------------------------------
// 3. MOTOR PRINCIPAL DEL BOT (BAILEYS)
// ---------------------------------------------------------------------------
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
            if (shouldReconnect) iniciarBot();
        } else if (connection === 'open') {
            console.log('¡Bot de Huevos Santa Estela conectado con éxito a WhatsApp!');
        }
    });

    // Memoria para evitar duplicados si WhatsApp reintenta el evento de mensaje
    const mensajesProcesadosRecent = new Set();

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageId = msg.key.id;
        if (mensajesProcesadosRecent.has(messageId)) return; // Ignora duplicados del mismo mensaje
        mensajesProcesadosRecent.add(messageId);
        setTimeout(() => mensajesProcesadosRecent.delete(messageId), 10000); // Limpia registro a los 10s

        const currentJid = msg.key.remoteJid;
        const textoCliente = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!textoCliente) return;

        console.log(`Mensaje recibido de ${currentJid}: ${textoCliente}`);

        try {
            guardarMensaje(currentJid, 'user', textoCliente);
            const datosSheets = await obtenerDatosSheets();
            
            const keyCliente = currentJid.split('@')[0];
            const esLid = currentJid.includes('@lid');
            
            const clienteRegistrado = datosSheets.clientes?.[keyCliente] || datosSheets.clientes?.[currentJid] || null;
            const telefonoOficial = clienteRegistrado?.telefono || (!esLid ? keyCliente : null);

            const pedidosCliente = (datosSheets.pedidos || []).filter(p => 
                p.cliente === currentJid || p.cliente.includes(keyCliente) || (clienteRegistrado && p.cliente.includes(clienteRegistrado.nombre))
            );

            const inventarioTexto = (datosSheets.stock && datosSheets.stock.length > 0) ? JSON.stringify(datosSheets.stock) : "No disponible";
            const configTexto = JSON.stringify(datosSheets.config || {});
            const vendedoresTexto = JSON.stringify(datosSheets.vendedores || []);
            const faqTexto = JSON.stringify(datosSheets.faq || []);
            const pedidosClienteTexto = JSON.stringify(pedidosCliente);

            const historial = obtenerHistorial(currentJid);
            const contextoHistorial = historial
                .map(m => `${m.role === 'user' ? 'Cliente' : 'Asistente'}: ${m.text}`)
                .join('\n');

            const prompt = `Eres la asistente virtual oficial del "Gallinero Huevos Santa Estela". Atiendes con amabilidad, rapidez y calidez en español chileno.

BASE DE DATOS DINÁMICA (DESDE GOOGLE SHEETS):
- INVENTARIO Y PRODUCTOS: 
${inventarioTexto}
- HISTORIAL DE PEDIDOS DE ESTE CLIENTE: 
${pedidosClienteTexto}
- CONFIGURACIÓN Y REDES: 
${configTexto}
- CONTACTO VENDEDORES / DISTRIBUIDORES: 
${vendedoresTexto}
- PREGUNTAS FRECUENTES (FAQ): 
${faqTexto}

DATOS DEL CLIENTE EN LA TABLA CLIENTES / WHATSAPP:
- JID Actual: 
${currentJid}
- Teléfono Registrado: 
${telefonoOficial ? telefonoOficial : 'NO REGISTRADO (Requiere pedir número)'}
- Nombre Registrado: 
${clienteRegistrado ? clienteRegistrado.nombre : 'No registrado aún'}
- Dirección Registrada: 
${clienteRegistrado ? clienteRegistrado.direccion : 'No registrada aún'}

REGLAS DE ATENCIÓN HÍBRIDA:
1. Si el cliente saluda o pregunta en general, atiéndelo amablemente e incluye al final una guía opcional:
   "Si deseas comprar o revisar tu despacho, dime qué necesitas. También puedes escribirme: 'Estado Despacho', 'Redes', 'Distribuidor', 'Reclamo' o 'Receta'."
2. CONSULTA DE ESTADO DE DESPACHO / PEDIDO:
   - Si pregunta por su despacho o estado de compra, revisa HISTORIAL DE PEDIDOS y diles el ID, dirección y estado actual.
3. VENTA DIRECTA:
   - Muestra el catálogo ordenado con precio y stock.
   - SI YA TENEMOS SU NOMBRE Y DIRECCIÓN (Cliente Registrado), **NO vuelvas a pedirlos**. Saluda por su nombre y confirma si enviamos a su dirección registrada.
   - SI NO ESTÁ REGISTRADO y el "Teléfono Registrado" aparece como NO REGISTRADO, pídele amablemente su Nombre, Dirección y Teléfono de contacto (+56 9...).
4. CONFIRMACIÓN DE PEDIDO: Cuando confirme la compra, incluye la etiqueta técnica al final con el teléfono disponible:

[REGISTRAR_PEDIDO:{"idProducto":"PROD-XXX","cantidad":X,"total":X,"metodoPago":"Mercado Pago o Contra Entrega","nombreCliente":"${clienteRegistrado ? clienteRegistrado.nombre : 'Cliente'}","telefonoContacto":"${telefonoOficial || keyCliente}","direccion":"${clienteRegistrado ? clienteRegistrado.direccion : 'Dirección ingresada'}","descripcion":"Huevos Santa Estela"}]

Historial de esta conversación:
${contextoHistorial}

Responde de forma amable y breve (máximo 3 frases) representando a Huevos Santa Estela. **IMPORTANTE: Si incluyes la etiqueta [REGISTRAR_PEDIDO:...], NO escribas enlaces de pago en tu texto, el sistema los agregará automáticamente**: "${textoCliente}"`;

            let respuestaIA = await generarConReintentos(prompt);
            let linkPagoGenerado = "";

            if (respuestaIA.includes('[REGISTRAR_PEDIDO:')) {
                const match = respuestaIA.match(/\[REGISTRAR_PEDIDO:(.*?)\]/);
                if (match && match[1]) {
                    try {
                        const datosPedido = JSON.parse(match[1]);
                        const idPedido = 'PED-' + Date.now().toString().slice(-4);

                        if (datosPedido.metodoPago.toLowerCase().includes('mercado')) {
                            linkPagoGenerado = await generarLinkMercadoPago(
                                idPedido,
                                datosPedido.total,
                                `${datosPedido.descripcion || 'Huevos Santa Estela'} (${datosPedido.idProducto})`
                            );
                            respuestaIA += `\n\n💳 *Enlace de Pago Mercado Pago ($${datosPedido.total} CLP):*\n${linkPagoGenerado}`;
                        }

                        await registrarPedidoSheets(
                            idPedido,
                            datosPedido.idProducto,
                            datosPedido.cantidad,
                            currentJid,
                            datosPedido.total,
                            datosPedido.metodoPago,
                            datosPedido.direccion,
                            datosPedido.nombreCliente,
                            datosPedido.telefonoContacto || telefonoOficial || keyCliente,
                            linkPagoGenerado
                        );
                    } catch (errJson) {
                        console.error("Error al procesar JSON de pedido:", errJson.message);
                    }
                }
                respuestaIA = respuestaIA.replace(/\[REGISTRAR_PEDIDO:.*?\]/g, '').trim();
            }

            guardarMensaje(currentJid, 'assistant', respuestaIA);
            await sock.sendMessage(currentJid, { text: respuestaIA });
            console.log(`Respuesta enviada con éxito a ${currentJid}`);

        } catch (error) {
            console.error('Error al procesar con la IA:', error.message);
        }
    });
}

iniciarBot();