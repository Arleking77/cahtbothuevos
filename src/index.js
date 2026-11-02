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

const memoriaClientes = {};
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
        console.log("[Sheets] Pedido guardado exitosamente en la hoja.");
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
            const textMessage = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!textMessage) return;

            const telefonoLimpio = currentJid.split('@')[0].replace(/\D/g, '');
            const telSufijo = telefonoLimpio.slice(-8);

            // Cargar datos actualizados desde Google Sheets
            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const clientesMap = datosSheet.clientes || {};
            const despachos = datosSheet.despachos || [];

            // Buscar si el cliente ya existe en el Sheet por sufijo telefónico
            let clienteSheet = null;
            for (let telKey in clientesMap) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    clienteSheet = clientesMap[telKey];
                    break;
                }
            }

            // Inicializar memoria de estado si no existe
            if (!memoriaClientes[telefonoLimpio]) {
                memoriaClientes[telefonoLimpio] = {
                    nombre: clienteSheet ? clienteSheet.nombre : null,
                    comuna: clienteSheet ? clienteSheet.comuna : null,
                    direccion: clienteSheet ? clienteSheet.direccion : null,
                    zona: "Santiago Sector 1",
                    paso: clienteSheet ? "LISTO_PARA_PEDIR" : "ESPERANDO_DATOS"
                };
            }
            let est = memoriaClientes[telefonoLimpio];

            // Si el cliente ya está en Excel pero la memoria estaba limpia, sincronizamos
            if (clienteSheet && est.paso !== "LISTO_PARA_PEDIR") {
                est.nombre = clienteSheet.nombre;
                est.comuna = clienteSheet.comuna;
                est.direccion = clienteSheet.direccion;
                est.paso = "LISTO_PARA_PEDIR";
            }

            // Buscar la zona de despacho según la comuna actual
            if (est.comuna) {
                let zonaEncontrada = "Santiago Sector 1";
                for (let d of despachos) {
                    if (d.comuna.toLowerCase() === est.comuna.toLowerCase()) {
                        zonaEncontrada = d.zona;
                        break;
                    }
                }
                est.zona = zonaEncontrada;
            }

            // MÁQUINA DE ESTADOS INTELIGENTE PARA CLIENTES NUEVOS
            if (est.paso === "ESPERANDO_DATOS") {
                // Usamos Gemini para extraer de forma inteligente el nombre y la comuna del mensaje del usuario
                const modelExtraccion = genAI.getGenerativeModel({ model: MODELO_SEGURO });
                const promptExtraccion = `Analiza el siguiente mensaje de un cliente nuevo de Huevos Santa Estela: "${textMessage}"
                Extrae su nombre y su comuna si aparecen. Responde ÚNICAMENTE en formato JSON plano con esta estructura exacta, sin bloques de código markdown:
                {"nombre": "nombre extraído o null", "comuna": "comuna extraída o null"}`;

                try {
                    const resExt = await modelExtraccion.generateContent(promptExtraccion);
                    const jsonTxt = resExt.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
                    const datosExtraidos = JSON.parse(jsonTxt);

                    if (datosExtraidos.nombre && !est.nombre) est.nombre = datosExtraidos.nombre;
                    if (datosExtraidos.comuna && !est.comuna) est.comuna = datosExtraidos.comuna;
                } catch (e) {
                    // Si falla el parseo inteligente, guardamos de forma directa el mensaje como nombre si no lo tenía
                    if (!est.nombre) est.nombre = textMessage;
                }

                // Si aún nos falta el nombre
                if (!est.nombre) {
                    await sock.sendMessage(currentJid, { text: `¡Hola! Qué gusto saludarte en *Huevos Santa Estela* 🥚. Para brindarte la mejor atención, ¿podrías indicarme tu *nombre* por favor?` });
                    return;
                }

                // Si ya tenemos el nombre pero nos falta la comuna
                if (!est.comuna) {
                    est.paso = "ESPERANDO_COMUNA";
                    await sock.sendMessage(currentJid, { text: `¡Mucho gusto, ${est.nombre}! ¿De qué *comuna* nos escribes para indicarte los precios y tarifas exactas para tu zona?` });
                    return;
                }

                // Si ya tenemos ambos datos capturados
                est.paso = "LISTO_PARA_PEDIR";
            }

            // Si estaba esperando específicamente la comuna en el paso anterior
            if (est.paso === "ESPERANDO_COMUNA") {
                est.comuna = textMessage.trim();
                est.paso = "LISTO_PARA_PEDIR";
            }

            // Actualizar zona tras tener comuna segura
            if (est.comuna) {
                let zonaEncontrada = "Santiago Sector 1";
                for (let d of despachos) {
                    if (d.comuna.toLowerCase() === est.comuna.toLowerCase()) {
                        zonaEncontrada = d.zona;
                        break;
                    }
                }
                est.zona = zonaEncontrada;
            }

            // --- BLOQUE DE ATENCIÓN Y COMPRA (LISTO_PARA_PEDIR) ---
            let zonaCliente = (est.zona || "").toLowerCase();
            let catalogoTexto = "";
            let productosMap = {};

            catalogo.forEach(p => {
                let precioFinal = p.precioStgo1 || p.precioLinares || 6000;
                if (zonaCliente.includes("sector 2")) {
                    precioFinal = p.precioStgo2 || precioFinal;
                } else if (zonaCliente.includes("linares")) {
                    precioFinal = p.precioLinares || precioFinal;
                } else {
                    precioFinal = p.precioStgo1 || precioFinal;
                }
                productosMap[p.id] = { categoria: p.categoria, formato: p.formato, precio: precioFinal };
                catalogoTexto += `- [ID: ${p.id}] ${p.categoria} (${p.descripcion} - ${p.formato}) -> Precio: $${precioFinal} CLP\n`;
            });

            const model = genAI.getGenerativeModel({ model: MODELO_SEGURO });
            let promptSistema = `Eres el asistente virtual experto, directo y amable de "Huevos Santa Estela".
            
            DATOS OFICIALES DEL CLIENTE (ESTRICTAMENTE PROHIBIDO VOLVER A PEDIR NOMBRE O COMUNA):
            - Nombre: ${est.nombre}
            - Comuna: ${est.comuna}
            - Zona de Despacho: ${est.zona}
            - Teléfono: ${telefonoLimpio}

            CATÁLOGO Y PRECIOS OFICIALES PARA SU ZONA:
            ${catalogoTexto}

            INSTRUCCIONES:
            1. Atiende a ${est.nombre} amablemente sabiendo que es de ${est.comuna} (${est.zona}).
            2. Si el cliente saluda por primera vez o pregunta por precios, muéstrale el catálogo actualizado de su zona y pregúntale qué desea llevar.
            3. Si ya hizo un pedido o menciona cantidades, confírmale el total y el proceso.
            `;

            const resultado = await model.generateContent(`${promptSistema}\n\nMensaje del cliente: "${textMessage}"`);
            let respuestaIA = resultado.response.text();

            // Detección automática de intención de compra
            const textoLower = textMessage.toLowerCase();
            if (textoLower.includes("jumbo") || textoLower.includes("extra") || textoLower.includes("primera") || textoLower.includes("bandeja") || textoLower.includes("unidades") || textoLower.includes("llevar") || textoLower.includes("quiero")) {
                
                let productoElegido = catalogo[0];
                if (textoLower.includes("extra")) productoElegido = catalogo[1] || catalogo[0];
                if (textoLower.includes("primera") || textoLower.includes("grande")) productoElegido = catalogo[2] || catalogo[0];
                if (textoLower.includes("segunda") || textoLower.includes("mediano")) productoElegido = catalogo[3] || catalogo[0];

                let cantidad = 1;
                let matchCant = textMessage.match(/\d+/);
                if (matchCant) cantidad = parseInt(matchCant[0]);

                let precioUnitario = productosMap[productoElegido.id] ? productosMap[productoElegido.id].precio : 6000;
                let totalCalculado = precioUnitario * cantidad;

                let linkPagoFinal = "";
                if (mpClient) {
                    try {
                        const preference = new Preference(mpClient);
                        const prefResponse = await preference.create({
                            body: {
                                items: [{
                                    title: `${productoElegido.categoria} (${productoElegido.formato}) x${cantidad}`,
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
                        console.error("[Mercado Pago Error]:", mpErr.message);
                    }
                }

                await guardarPedidoEnSheets({
                    idPedido: "PED-" + Math.floor(1000 + Math.random() * 9000),
                    nombreCliente: est.nombre || "Cliente WhatsApp",
                    telefono: telefonoLimpio,
                    idProducto: productoElegido.id,
                    cantidad: cantidad,
                    total: totalCalculado,
                    metodoPago: "Mercado Pago",
                    comuna: est.comuna || "Santiago",
                    direccion: est.direccion || est.comuna || "Por confirmar",
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