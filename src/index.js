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

// Memoria persistente simple por número de teléfono
const memoriaUsuarios = {};

async function generarRespuestaDirecta(promptSistema, textoUsuario) {
    try {
        const modelo = genAI.getGenerativeModel({ model: MODELO_ESTABLE });
        const resultado = await modelo.generateContent(`${promptSistema}\n\nMensaje del cliente: "${textoUsuario}"`);
        return resultado.response.text();
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
                linkLinkPago: linkPago || '', idPagoMP: idPagoMP || ''
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

            const telefonoLimpio = currentJid.split('@')[0].replace(/\D/g, '');

            if (!memoriaUsuarios[telefonoLimpio]) {
                memoriaUsuarios[telefonoLimpio] = { nombre: null, comuna: null, zona: null };
            }
            const usuario = memoriaUsuarios[telefonoLimpio];

            const datosSheet = await obtenerDatosSheets();
            const catalogo = datosSheet.stock || [];
            const infoClientes = datosSheet.clientes || {};
            const lugaresDespacho = datosSheet.despachos || [];

            // Buscar en clientes del Excel
            const telSufijo = telefonoLimpio.slice(-8);
            for (let telKey in infoClientes) {
                const keyClean = String(telKey).replace(/\D/g, '');
                if (keyClean === telefonoLimpio || keyClean.endsWith(telSufijo) || telefonoLimpio.endsWith(keyClean.slice(-8))) {
                    const cli = infoClientes[telKey];
                    if (cli.nombre) usuario.nombre = cli.nombre;
                    if (cli.comuna) usuario.comuna = cli.comuna;
                    break;
                }
            }

            const textoLimpio = textMessage.trim();

            // Detectar comuna si la menciona
            for (let d of lugaresDespacho) {
                if (d.comuna && textoLimpio.toLowerCase().includes(d.comuna.toLowerCase())) {
                    usuario.comuna = d.comuna;
                    usuario.zona = d.zona;
                    break;
                }
            }

            // Detectar nombre si lo escribe
            if (!usuario.nombre && !/^\d+$/.test(textoLimpio) && textoLimpio.length > 2 && !textoLimpio.toLowerCase().includes('hola')) {
                const partes = textoLimpio.split(',');
                usuario.nombre = partes[0].trim();
                if (partes.length > 1) {
                    const posibleComuna = partes[1].trim();
                    for (let d of lugaresDespacho) {
                        if (d.comuna && posibleComuna.toLowerCase().includes(d.comuna.toLowerCase())) {
                            usuario.comuna = d.comuna;
                            usuario.zona = d.zona;
                        }
                    }
                }
            }

            let zonaAplicada = usuario.zona || "Santiago Sector 1";
            if (usuario.comuna) {
                for (let d of lugaresDespacho) {
                    if (d.comuna && usuario.comuna.toLowerCase().includes(d.comuna.toLowerCase())) {
                        zonaAplicada = d.zona || "Santiago Sector 1";
                        break;
                    }
                }
            }

            let catalogoTexto = "";
            catalogo.forEach(p => {
                let precioZona = p.precio;
                const zl = zonaAplicada.toLowerCase();
                if (zl.includes('linares')) precioZona = p.precioLinares || p.precio;
                else if (zl.includes('sector 2')) precioZona = p.precioStgo2 || p.precio + 500;
                else precioZona = p.precioStgo1 || p.precio;

                catalogoTexto += `- [ID: ${p.id}] ${p.categoria} (${p.descripcion}) -> Precio en ${zonaAplicada}: $${precioZona} CLP\n`;
            });

            let promptSistema = `Eres el asistente virtual experto, directo y amable de "Huevos Santa Estela".
            
            ESTADO ACTUAL DEL CLIENTE:
            - Nombre registrado: ${usuario.nombre || 'No registrado'}
            - Comuna registrada: ${usuario.comuna || 'No registrada'}
            - Zona asignada: ${zonaAplicada}

            CATÁLOGO Y PRECIOS OFICIALES PARA SU ZONA:
            ${catalogoTexto}

            REGLAS ESTRICTAS:
            1. SI EL CLIENTE YA TIENE NOMBRE Y COMUNA: Salúdalo por su nombre, recuérdale su comuna y MUESTRA DE INMEDIATO LOS PRECIOS EXACTOS del catálogo detallado arriba según su zona si los solicita o si pregunta por ellos. ¡NUNCA vuelvas a pedir el nombre ni la comuna si ya los tenemos!
            2. SI FALTA EL NOMBRE O LA COMUNA: Pídeselos amablemente.
            3. PROHIBICIÓN: Nunca menciones la palabra stock o disponibilidad.
            4. PEDIDOS: Si indica producto, cantidad, pago y dirección, agrega al final:
            [REGISTRAR_PEDIDO:{"idPedido":"PED-${Math.floor(1000 + Math.random() * 9000)}","idProducto":"<ID>","cantidad":<NUM>,"total":<NUM>,"metodoPago":"<METODO>","direccion":"<DIRECCION>","nombreCliente":"<NOMBRE>","telefonoContacto":"<TEL>"}]
            `;

            const respuestaIA = await generarRespuestaDirecta(promptSistema, textMessage);
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