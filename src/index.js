import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { MercadoPagoConfig, Preference } from "mercadopago";
import dotenv from "dotenv";
import http from "http";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

dotenv.config();

/* =========================================================
   CONFIGURACIÓN GENERAL
========================================================= */

const URL_APPS_SCRIPT = process.env.URL_APPS_SCRIPT;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = Number(process.env.PORT) || 3000;

const MODELO_GEMINI =
    process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const ESTADOS_FILE =
    process.env.ESTADOS_FILE ||
    path.resolve("./clientes_estado.json");

const MAX_CANTIDAD_PEDIDO = 100;
const TIEMPO_BLOQUEO_MENSAJE = 5 * 60 * 1000;
const TIEMPO_RECONEXION = 5000;

if (!GEMINI_API_KEY) {
    throw new Error(
        "Falta la variable de entorno GEMINI_API_KEY."
    );
}

if (!URL_APPS_SCRIPT) {
    console.warn(
        "[Configuración] No se encontró URL_APPS_SCRIPT."
    );
}

if (!MP_ACCESS_TOKEN) {
    console.warn(
        "[Configuración] No se encontró MP_ACCESS_TOKEN. " +
        "El bot funcionará sin generar links de pago."
    );
}

/* =========================================================
   CLIENTES EXTERNOS
========================================================= */

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let mpClient = null;

if (MP_ACCESS_TOKEN) {
    try {
        mpClient = new MercadoPagoConfig({
            accessToken: MP_ACCESS_TOKEN
        });

        console.log(
            "[Mercado Pago] SDK inicializado correctamente."
        );
    } catch (error) {
        console.error(
            "[Mercado Pago] Error inicializando SDK:",
            error.message
        );
    }
}

/* =========================================================
   MEMORIA LOCAL
========================================================= */

let memoriaClientes = {};
const processedMessages = new Map();
const conversacionesProcesando = new Set();

function cargarMemoria() {
    try {
        if (!fs.existsSync(ESTADOS_FILE)) {
            memoriaClientes = {};
            return;
        }

        const contenido = fs.readFileSync(
            ESTADOS_FILE,
            "utf8"
        );

        memoriaClientes = JSON.parse(contenido);

        console.log(
            `[Memoria] ${Object.keys(memoriaClientes).length} ` +
            "claves cargadas."
        );
    } catch (error) {
        console.error(
            "[Memoria] Error cargando estados:",
            error.message
        );

        memoriaClientes = {};
    }
}

function guardarMemoria() {
    try {
        const archivoTemporal = `${ESTADOS_FILE}.tmp`;

        fs.writeFileSync(
            archivoTemporal,
            JSON.stringify(memoriaClientes, null, 2),
            "utf8"
        );

        fs.renameSync(
            archivoTemporal,
            ESTADOS_FILE
        );
    } catch (error) {
        console.error(
            "[Memoria] Error guardando estados:",
            error.message
        );
    }
}

function crearEstadoCliente() {
    return {
        telefono: null,
        nombre: null,
        comuna: null,
        direccion: null,
        zona: null,
        paso: "ESPERANDO_DATOS",
        pedidoActual: null,
        ultimoPedido: null,
        actualizadoEn: new Date().toISOString()
    };
}

function buscarEstadoCliente(claveConversacion, telefono) {
    if (
        claveConversacion &&
        memoriaClientes[claveConversacion]
    ) {
        return memoriaClientes[claveConversacion];
    }

    if (
        telefono &&
        memoriaClientes[telefono]
    ) {
        return memoriaClientes[telefono];
    }

    return null;
}

function persistirEstadoCliente(
    claveConversacion,
    telefono,
    estado
) {
    estado.actualizadoEn = new Date().toISOString();

    if (claveConversacion) {
        memoriaClientes[claveConversacion] = estado;
    }

    if (telefono) {
        memoriaClientes[telefono] = estado;
    }

    guardarMemoria();
}

function eliminarPedidoActual(
    claveConversacion,
    telefono,
    estado
) {
    estado.pedidoActual = null;
    estado.paso = "LISTO_PARA_PEDIR";

    persistirEstadoCliente(
        claveConversacion,
        telefono,
        estado
    );
}

cargarMemoria();

/* =========================================================
   FUNCIONES DE NORMALIZACIÓN
========================================================= */

function normalizarTexto(valor = "") {
    return String(valor)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function normalizarTelefono(valor) {
    let telefono = String(valor || "")
        .replace(/\D/g, "")
        .replace(/^0+/, "");

    if (/^9\d{8}$/.test(telefono)) {
        telefono = `56${telefono}`;
    }

    /*
     * Algunos datos pueden venir como 0569XXXXXXXX.
     */
    if (/^0569\d{8}$/.test(telefono)) {
        telefono = telefono.slice(1);
    }

    return telefono;
}

function telefonoEsValido(telefono) {
    return /^569\d{8}$/.test(
        normalizarTelefono(telefono)
    );
}

function formatearCLP(valor) {
    const numero = Number(valor || 0);

    return numero.toLocaleString("es-CL", {
        style: "currency",
        currency: "CLP",
        maximumFractionDigits: 0
    });
}

function limpiarJSON(texto) {
    return String(texto || "")
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
}

function parsearJSONSeguro(texto, valorDefecto = null) {
    try {
        return JSON.parse(limpiarJSON(texto));
    } catch (error) {
        console.error(
            "[JSON] No fue posible interpretar la respuesta:",
            texto
        );

        return valorDefecto;
    }
}

function obtenerTextoMensaje(message) {
    if (!message) return "";

    return String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        ""
    ).trim();
}

function extraerNumeroWhatsApp(msg) {
    const candidatos = [
        msg?.key?.remoteJidAlt,
        msg?.key?.senderPn,
        msg?.key?.participantAlt,
        msg?.key?.remoteJid,
        msg?.key?.participant
    ].filter(Boolean);

    /*
     * Primero buscamos explícitamente un JID de número telefónico.
     */
    for (const candidato of candidatos) {
        const jid = String(candidato);

        if (jid.includes("@s.whatsapp.net")) {
            const numero = normalizarTelefono(
                jid.split("@")[0]
            );

            if (telefonoEsValido(numero)) {
                return numero;
            }
        }
    }

    /*
     * Como respaldo, revisamos candidatos que no sean @lid.
     */
    for (const candidato of candidatos) {
        const jid = String(candidato);

        if (jid.includes("@lid")) {
            continue;
        }

        const numero = normalizarTelefono(
            jid.split("@")[0]
        );

        if (telefonoEsValido(numero)) {
            return numero;
        }
    }

    return null;
}

function corregirZona(zona) {
    const zonaNormalizada = normalizarTexto(zona);

    if (zonaNormalizada.includes("lintares")) {
        return "Linares";
    }

    return String(zona || "").trim();
}

function esRespuestaPositiva(texto) {
    const valor = normalizarTexto(texto);

    const respuestas = [
        "si",
        "sí",
        "confirmo",
        "confirmar",
        "correcto",
        "dale",
        "ok",
        "okay",
        "esta bien",
        "de acuerdo",
        "acepto",
        "procede",
        "hagamoslo",
        "lo confirmo"
    ];

    return respuestas.some((respuesta) =>
        valor === normalizarTexto(respuesta) ||
        valor.startsWith(
            `${normalizarTexto(respuesta)} `
        )
    );
}

function esRespuestaNegativa(texto) {
    const valor = normalizarTexto(texto);

    const respuestas = [
        "no",
        "cancelar",
        "cancela",
        "cancelalo",
        "anular",
        "anula",
        "cambiar",
        "modificar",
        "equivocado",
        "no confirmo"
    ];

    return respuestas.some((respuesta) =>
        valor === normalizarTexto(respuesta) ||
        valor.startsWith(
            `${normalizarTexto(respuesta)} `
        )
    );
}

/* =========================================================
   MENSAJES PROCESADOS
========================================================= */

function mensajeYaProcesado(messageId) {
    if (!messageId) return false;

    const ahora = Date.now();
    const fechaRegistro = processedMessages.get(messageId);

    if (
        fechaRegistro &&
        ahora - fechaRegistro < TIEMPO_BLOQUEO_MENSAJE
    ) {
        return true;
    }

    processedMessages.set(messageId, ahora);

    /*
     * Limpieza para evitar crecimiento indefinido.
     */
    if (processedMessages.size > 5000) {
        for (const [
            id,
            fecha
        ] of processedMessages.entries()) {
            if (
                ahora - fecha >
                TIEMPO_BLOQUEO_MENSAJE
            ) {
                processedMessages.delete(id);
            }
        }
    }

    return false;
}

/* =========================================================
   GOOGLE SHEETS
========================================================= */

async function obtenerDatosSheets() {
    const resultadoDefecto = {
        productos: [],
        stock: [],
        clientes: {},
        despachos: [],
        pedidos: [],
        configuracion: {},
        vendedores: [],
        respuestasFrecuentes: []
    };

    if (!URL_APPS_SCRIPT) {
        return resultadoDefecto;
    }

    try {
        const separador = URL_APPS_SCRIPT.includes("?")
            ? "&"
            : "?";

        const url =
            `${URL_APPS_SCRIPT}${separador}` +
            `timestamp=${Date.now()}`;

        const response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: {
                "Cache-Control": "no-cache"
            }
        });

        if (!response.ok) {
            throw new Error(
                `Google Sheets respondió HTTP ${response.status}`
            );
        }

        const texto = await response.text();
        const data = JSON.parse(texto);

        /*
         * Compatibilidad con la estructura actual del Apps Script:
         * data.stock contiene actualmente el catálogo.
         */
        const productos =
            data.productos ||
            data.stock ||
            [];

        return {
            productos,
            stock: data.stockReal || [],
            clientes: data.clientes || {},
            despachos: data.despachos || [],
            pedidos: data.pedidos || [],
            configuracion: data.configuracion || {},
            vendedores: data.vendedores || [],
            respuestasFrecuentes:
                data.respuestasFrecuentes || []
        };
    } catch (error) {
        console.error(
            "[Sheets GET] Error:",
            error.message
        );

        return resultadoDefecto;
    }
}

async function guardarPedidoEnSheets(pedidoData) {
    if (!URL_APPS_SCRIPT) {
        throw new Error(
            "No se configuró URL_APPS_SCRIPT."
        );
    }

    const response = await fetch(URL_APPS_SCRIPT, {
        method: "POST",
        redirect: "follow",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(pedidoData)
    });

    const textoRespuesta = await response.text();

    if (!response.ok) {
        throw new Error(
            `Sheets respondió HTTP ${response.status}: ` +
            textoRespuesta
        );
    }

    let resultado;

    try {
        resultado = JSON.parse(textoRespuesta);
    } catch {
        throw new Error(
            `Sheets entregó una respuesta inválida: ` +
            textoRespuesta
        );
    }

    if (resultado.status !== "success") {
        throw new Error(
            resultado.message ||
            "No fue posible registrar el pedido."
        );
    }

    console.log(
        `[Sheets] Pedido ${pedidoData.idPedido} registrado.`
    );

    return resultado;
}

/* =========================================================
   CLIENTES Y TELÉFONOS
========================================================= */

function buscarClienteEnSheets(clientesMap, telefono) {
    const telefonoBuscado = normalizarTelefono(telefono);

    if (!telefonoBuscado) {
        return null;
    }

    for (const [
        telefonoKey,
        cliente
    ] of Object.entries(clientesMap || {})) {
        const candidatos = [
            telefonoKey,
            cliente?.telefono
        ];

        for (const candidato of candidatos) {
            const telefonoExcel =
                normalizarTelefono(candidato);

            if (
                telefonoExcel &&
                telefonoExcel === telefonoBuscado
            ) {
                return {
                    ...cliente,
                    telefono: telefonoBuscado
                };
            }
        }
    }

    return null;
}

function buscarDespachoPorComuna(
    despachos,
    comuna
) {
    const comunaBuscada = normalizarTexto(comuna);

    if (!comunaBuscada) return null;

    return despachos.find((despacho) => {
        return (
            normalizarTexto(despacho.comuna) ===
            comunaBuscada
        );
    }) || null;
}

function asignarZonaCliente(estado, despachos) {
    if (!estado.comuna) {
        estado.zona = null;
        return null;
    }

    const despacho = buscarDespachoPorComuna(
        despachos,
        estado.comuna
    );

    if (!despacho) {
        estado.zona = null;
        return null;
    }

    estado.comuna =
        despacho.comuna || estado.comuna;

    estado.zona = corregirZona(
        despacho.zona
    );

    return despacho;
}

/* =========================================================
   CATÁLOGO Y PRECIOS
========================================================= */

function obtenerPrecioProducto(producto, zona) {
    const zonaNormalizada = normalizarTexto(zona);

    if (zonaNormalizada.includes("sector 2")) {
        return Number(
            producto.precioStgo2 ||
            producto.precioStgo1 ||
            producto.precioLinares ||
            0
        );
    }

    if (zonaNormalizada.includes("linares")) {
        return Number(
            producto.precioLinares ||
            producto.precioStgo1 ||
            producto.precioStgo2 ||
            0
        );
    }

    return Number(
        producto.precioStgo1 ||
        producto.precioStgo2 ||
        producto.precioLinares ||
        0
    );
}

function productoDisponibleEnZona(
    producto,
    zona
) {
    const disponibilidad = normalizarTexto(
        producto.disponibilidad
    );

    const zonaNormalizada = normalizarTexto(zona);

    if (
        disponibilidad.includes("no disponible") &&
        disponibilidad.includes("sector 2") &&
        zonaNormalizada.includes("sector 2")
    ) {
        return false;
    }

    if (
        disponibilidad.includes("no disponible") &&
        disponibilidad.includes("linares") &&
        zonaNormalizada.includes("linares")
    ) {
        return false;
    }

    if (
        disponibilidad === "no disponible" ||
        disponibilidad === "agotado"
    ) {
        return false;
    }

    const stockActual = Number(
        producto.stockActual ?? 0
    );

    return stockActual > 0;
}

function construirCatalogoTexto(
    catalogo,
    zona
) {
    if (!catalogo.length) {
        return "No hay productos disponibles.";
    }

    return catalogo
        .map((producto) => {
            const precio = obtenerPrecioProducto(
                producto,
                zona
            );

            const stock = Number(
                producto.stockActual ?? 0
            );

            const disponible = productoDisponibleEnZona(
                producto,
                zona
            );

            return [
                `ID: ${producto.id}`,
                `Categoría: ${producto.categoria}`,
                `Descripción: ${producto.descripcion || ""}`,
                `Gramaje: ${producto.gramaje || ""}`,
                `Formato: ${producto.formato}`,
                `Precio: ${formatearCLP(precio)}`,
                `Stock: ${stock}`,
                `Disponible: ${disponible ? "Sí" : "No"}`
            ].join(" | ");
        })
        .join("\n");
}

function buscarProductoPorId(
    catalogo,
    idProducto
) {
    const idNormalizado = normalizarTexto(
        idProducto
    );

    return catalogo.find((producto) =>
        normalizarTexto(producto.id) ===
        idNormalizado
    ) || null;
}

function buscarProductoLocalmente(
    catalogo,
    texto
) {
    const mensaje = normalizarTexto(texto);

    const equivalencias = [
        {
            palabras: [
                "jumbo",
                "junbo",
                "jumvo",
                "jubo",
                "especial"
            ],
            criterio: [
                "jumbo",
                "especial"
            ]
        },
        {
            palabras: [
                "extra",
                "extra grande"
            ],
            criterio: [
                "extra"
            ]
        },
        {
            palabras: [
                "primera",
                "grande"
            ],
            criterio: [
                "primera",
                "grande"
            ]
        },
        {
            palabras: [
                "segunda",
                "mediano",
                "mediana"
            ],
            criterio: [
                "segunda",
                "mediano",
                "mediana"
            ]
        },
        {
            palabras: [
                "tercera",
                "chico",
                "chica",
                "pequeno",
                "pequena"
            ],
            criterio: [
                "tercera",
                "chico",
                "pequeno"
            ]
        }
    ];

    for (const grupo of equivalencias) {
        const coincideMensaje =
            grupo.palabras.some((palabra) =>
                mensaje.includes(palabra)
            );

        if (!coincideMensaje) continue;

        const producto = catalogo.find((item) => {
            const contenido = normalizarTexto(
                [
                    item.id,
                    item.categoria,
                    item.descripcion,
                    item.gramaje,
                    item.formato
                ].join(" ")
            );

            return grupo.criterio.some(
                (criterio) =>
                    contenido.includes(criterio)
            );
        });

        if (producto) {
            return producto;
        }
    }

    return null;
}

function extraerCantidadLocal(texto) {
    const match = String(texto || "")
        .match(/\b(\d{1,3})\b/);

    if (!match) return null;

    const cantidad = Number.parseInt(
        match[1],
        10
    );

    if (
        !Number.isInteger(cantidad) ||
        cantidad < 1 ||
        cantidad > MAX_CANTIDAD_PEDIDO
    ) {
        return null;
    }

    return cantidad;
}

/* =========================================================
   GEMINI
========================================================= */

async function extraerDatosCliente(
    mensaje,
    despachos
) {
    const comunas = despachos
        .map((despacho) => despacho.comuna)
        .filter(Boolean)
        .slice(0, 200)
        .join(", ");

    const modelo = genAI.getGenerativeModel({
        model: MODELO_GEMINI
    });

    const prompt = `
Analiza el siguiente mensaje de un cliente de una tienda de huevos:

"${mensaje}"

Extrae únicamente la información que el cliente escribió.

Debes identificar:
- nombre
- comuna
- dirección

Las comunas conocidas incluyen:
${comunas}

Reglas:
1. No inventes información.
2. Si falta un dato, usa null.
3. Una dirección puede incluir calle, avenida, pasaje, parcela o camino y un número.
4. No incluyas la comuna dentro de la dirección.
5. "San Bernardo", "Las Condes", "Maipú" y "Linares" son comunas.
6. Si el mensaje dice "Pablo, Ancud 0103, San Bernardo":
   - nombre es Pablo
   - dirección es Ancud 0103
   - comuna es San Bernardo
7. Responde únicamente JSON válido, sin markdown.

Formato exacto:
{
  "nombre": null,
  "comuna": null,
  "direccion": null
}
`;

    const resultado =
        await modelo.generateContent(prompt);

    return parsearJSONSeguro(
        resultado.response.text(),
        {
            nombre: null,
            comuna: null,
            direccion: null
        }
    );
}

function extraerItemsLocales(catalogo, texto) {
    const mensaje = normalizarTexto(texto);
    const defs = [
        { aliases: ["jumbo","junbo","jumvo","jimbo","jubo","especial"], criterios: ["jumbo","especial"] },
        { aliases: ["extra grande","extras","extra"], criterios: ["extra"] },
        { aliases: ["primera","grandes","grande"], criterios: ["primera","grande"] },
        { aliases: ["segunda","medianos","medianas","mediano","mediana"], criterios: ["segunda","mediano","mediana"] },
        { aliases: ["tercera","chicos","chicas","chico","chica","pequeno","pequena"], criterios: ["tercera","chico","pequeno"] }
    ];
    const presentes = defs.filter(d => d.aliases.some(a => mensaje.includes(a)));
    const items = [];
    for (const def of presentes) {
        const alias = def.aliases.find(a => mensaje.includes(a));
        const producto = catalogo.find(p => {
            const contenido = normalizarTexto([p.id,p.categoria,p.descripcion,p.gramaje,p.formato].join(" "));
            return def.criterios.some(c => contenido.includes(c));
        });
        if (!producto) continue;
        const pos = mensaje.indexOf(alias);
        const antes = mensaje.slice(Math.max(0, pos - 35), pos);
        const numeros = antes.match(/(\d{1,3})\s*(?:bandejas?|cajas?|unidades?)?\s*(?:de\s+)?$/);
        let cantidad = numeros ? Number.parseInt(numeros[1],10) : null;
        if (!cantidad && presentes.length === 1) cantidad = extraerCantidadLocal(mensaje);
        if (cantidad && cantidad >= 1 && cantidad <= MAX_CANTIDAD_PEDIDO) {
            items.push({ idProducto: producto.id, cantidad });
        }
    }
    return items;
}

async function interpretarPedido(mensaje, catalogo, zona) {
    const itemsLocales = extraerItemsLocales(catalogo, mensaje);
    if (itemsLocales.length) {
        return { tipo:"pedido", esPedido:true, items:itemsLocales, requiereAclaracion:false, aclaracion:null };
    }
    const modelo = genAI.getGenerativeModel({ model: MODELO_GEMINI });
    const prompt = `Clasifica el mensaje para Huevos Santa Estela y extrae TODOS los productos solicitados.
Mensaje: "${mensaje}"
Catálogo: ${construirCatalogoTexto(catalogo,zona)}
Reglas: usa solo IDs del catálogo; reconoce errores como jimbo, junbo y banfeja; una consulta de precios no es pedido; si pide 2 extras y 1 grande entrega dos items. Responde solo JSON válido:
{"tipo":"consulta","esPedido":false,"items":[],"requiereAclaracion":false,"aclaracion":null}`;
    const resultado = await modelo.generateContent(prompt);
    const salida = parsearJSONSeguro(resultado.response.text(), {tipo:"consulta",esPedido:false,items:[],requiereAclaracion:false,aclaracion:null});
    if (!Array.isArray(salida.items)) salida.items=[];
    return salida;
}

async function generarRespuestaConversacional({
    estado,
    mensaje,
    catalogo,
    configuracion,
    respuestasFrecuentes
}) {
    const modelo = genAI.getGenerativeModel({
        model: MODELO_GEMINI
    });

    const catalogoTexto =
        construirCatalogoTexto(
            catalogo,
            estado.zona
        );

    const faqTexto = respuestasFrecuentes
        .map((item) =>
            `${item.tema || "Tema"}: ` +
            `${item.respuesta || ""}`
        )
        .join("\n");

    const prompt = `
Eres el asistente virtual de "Huevos Santa Estela".

Datos confirmados del cliente:
- Nombre: ${estado.nombre || "No registrado"}
- Comuna: ${estado.comuna || "No registrada"}
- Dirección: ${estado.direccion || "No registrada"}
- Zona: ${estado.zona || "Pendiente de validar"}

Catálogo oficial para la zona:
${catalogoTexto}

Configuración:
${JSON.stringify(configuracion || {})}

Preguntas frecuentes oficiales:
${faqTexto || "No hay preguntas frecuentes configuradas."}

Mensaje del cliente:
"${mensaje}"

Instrucciones:
1. Responde en español chileno, de forma breve, clara y amable.
2. No vuelvas a pedir nombre, comuna o dirección si ya aparecen confirmados.
3. No inventes precios, stock, zonas, horarios ni condiciones.
4. Si el cliente pregunta por productos, utiliza exclusivamente el catálogo.
5. No confirmes una compra ni digas que fue registrada.
6. No generes enlaces de pago.
7. Si faltan datos oficiales, indica que deben validarse.
8. No repitas el saludo completo en cada mensaje.
`;

    const resultado =
        await modelo.generateContent(prompt);

    return resultado.response.text().trim();
}

/* =========================================================
   MERCADO PAGO
========================================================= */

function generarIdPedido() {
    const fecha = new Date()
        .toISOString()
        .replace(/\D/g, "")
        .slice(0, 14);

    const aleatorio = Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase();

    return `PED-${fecha}-${aleatorio}`;
}

async function crearPreferenciaMercadoPago({ idPedido, items, nombreCliente, telefono }) {
    if (!mpClient) return { linkPago: "", preferenceId: "" };
    const preference = new Preference(mpClient);
    const respuesta = await preference.create({
        body: {
            items: items.map(item => ({
                id: String(item.producto.id),
                title: `${item.producto.categoria} (${item.producto.formato})`,
                description: item.producto.descripcion || "",
                quantity: item.cantidad,
                unit_price: item.precioUnitario,
                currency_id: "CLP"
            })),
            payer: { name: nombreCliente || "Cliente WhatsApp", phone: { number: telefono || "" } },
            external_reference: idPedido,
            statement_descriptor: "HUEVOS SANTA ESTELA",
            metadata: { id_pedido:idPedido, telefono:telefono || "", cantidad_items:items.length }
        }
    });
    return {
        linkPago: respuesta.init_point || respuesta.sandbox_init_point || "",
        preferenceId: respuesta.id ? String(respuesta.id) : ""
    };
}

/* =========================================================
   MENSAJES DEL FLUJO
========================================================= */

function construirMensajeCatalogo(
    estado,
    catalogo
) {
    const productosDisponibles = catalogo.filter(
        (producto) =>
            productoDisponibleEnZona(
                producto,
                estado.zona
            )
    );

    const lineas = productosDisponibles.map(
        (producto) => {
            const precio = obtenerPrecioProducto(
                producto,
                estado.zona
            );

            return (
                `• *${producto.categoria}* ` +
                `(${producto.formato}): ` +
                `${formatearCLP(precio)}`
            );
        }
    );

    return [
        `¡Hola, ${estado.nombre}! 🥚`,
        "",
        `Encontré tus datos registrados:`,
        `📍 ${estado.direccion || "Dirección por confirmar"}, ` +
        `${estado.comuna}`,
        `🚚 ${estado.zona}`,
        "",
        "Productos disponibles para tu zona:",
        "",
        ...lineas,
        "",
        "Puedes escribir, por ejemplo:",
        '“1 bandeja Jumbo” o “2 bandejas Extra”.'
    ].join("\n");
}

function construirResumenPedido(estado, items) {
    const total = items.reduce((suma,item) => suma + item.subtotal, 0);
    const lineas = items.map(item =>
        `• ${item.cantidad} × ${item.producto.categoria} (${item.producto.formato}): ${formatearCLP(item.subtotal)}`
    );
    return [
        `Perfecto, ${estado.nombre} 🥚`, "", "*Resumen del pedido:*",
        ...lineas, "", `*Total: ${formatearCLP(total)}*`,
        `📍 ${estado.direccion || "Por confirmar"}, ${estado.comuna}`,
        "", "¿Confirmas los datos del pedido?",
        "Responde *Sí* para elegir el medio de pago o *No* para cancelarlo."
    ].join("\n");
}

function interpretarMetodoPago(texto) {
    const valor = normalizarTexto(texto);
    if (valor === "1" || valor.includes("mercado pago") || valor === "mp" || valor.includes("pago online")) return "Mercado Pago";
    if (valor === "2" || valor.includes("contra entrega") || valor.includes("al recibir") || valor.includes("efectivo")) return "Contra Entrega";
    return null;
}

function construirPreguntaMetodoPago(estado) {
    return [`Pedido confirmado, ${estado.nombre} 🥚`,"","¿Cómo prefieres pagar?","","1. *Mercado Pago*","2. *Contra entrega*","","Responde *1* o *2*."].join("\n");
}

/* =========================================================
   PROCESAMIENTO DEL CLIENTE
========================================================= */

async function cargarOCrearEstadoCliente({
    msg,
    currentJid,
    telefono,
    clientesMap,
    despachos
}) {
    let estado = buscarEstadoCliente(
        currentJid,
        telefono
    );

    if (estado) {
        /*
         * Completamos el teléfono si antes se guardó solamente por JID.
         */
        if (!estado.telefono && telefono) {
            estado.telefono = telefono;
        }

        asignarZonaCliente(
            estado,
            despachos
        );

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        return estado;
    }

    const clienteSheet =
        buscarClienteEnSheets(
            clientesMap,
            telefono
        );

    if (clienteSheet) {
        estado = {
            telefono,
            nombre:
                clienteSheet.nombre ||
                "Cliente",
            comuna:
                clienteSheet.comuna ||
                null,
            direccion:
                clienteSheet.direccion ||
                null,
            zona: null,
            paso: "LISTO_PARA_PEDIR",
            pedidoActual: null,
            ultimoPedido: null,
            actualizadoEn:
                new Date().toISOString()
        };

        asignarZonaCliente(
            estado,
            despachos
        );

        /*
         * Si Excel tenía cliente, pero no comuna reconocida,
         * se solicita corregirla.
         */
        if (!estado.comuna) {
            estado.paso = "ESPERANDO_COMUNA";
        } else if (!estado.zona) {
            estado.paso = "ESPERANDO_COMUNA";
        } else if (!estado.direccion) {
            estado.paso = "ESPERANDO_DIRECCION";
        }

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        console.log(
            "[Cliente] Encontrado en Excel:",
            {
                telefono,
                nombre: estado.nombre,
                comuna: estado.comuna,
                direccion: estado.direccion,
                zona: estado.zona
            }
        );

        return estado;
    }

    estado = crearEstadoCliente();
    estado.telefono = telefono;

    persistirEstadoCliente(
        currentJid,
        telefono,
        estado
    );

    console.warn(
        "[Cliente] No encontrado en Excel:",
        {
            remoteJid: msg.key.remoteJid,
            remoteJidAlt:
                msg.key.remoteJidAlt || null,
            senderPn:
                msg.key.senderPn || null,
            telefonoDetectado: telefono,
            cantidadClientes:
                Object.keys(
                    clientesMap || {}
                ).length,
            ejemplosTelefonos:
                Object.keys(
                    clientesMap || {}
                ).slice(0, 5)
        }
    );

    return estado;
}

async function procesarRegistroCliente({
    sock,
    currentJid,
    telefono,
    estado,
    mensaje,
    despachos
}) {
    if (estado.paso === "ESPERANDO_COMUNA") {
        const despacho =
            buscarDespachoPorComuna(
                despachos,
                mensaje
            );

        if (!despacho) {
            await sock.sendMessage(currentJid, {
                text:
                    "No pude identificar esa comuna en nuestra " +
                    "base de despachos. Escríbela nuevamente, " +
                    "por ejemplo: San Bernardo, Maipú o Linares."
            });

            return false;
        }

        estado.comuna = despacho.comuna;
        estado.zona = corregirZona(
            despacho.zona
        );

        if (!estado.direccion) {
            estado.paso =
                "ESPERANDO_DIRECCION";

            persistirEstadoCliente(
                currentJid,
                telefono,
                estado
            );

            await sock.sendMessage(currentJid, {
                text:
                    `Gracias, ${estado.nombre || ""}. ` +
                    "¿Cuál es la dirección de entrega?"
            });

            return false;
        }

        estado.paso = "LISTO_PARA_PEDIR";

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        return true;
    }

    if (estado.paso === "ESPERANDO_DIRECCION") {
        const direccion = String(mensaje).trim();

        if (direccion.length < 4) {
            await sock.sendMessage(currentJid, {
                text:
                    "La dirección parece incompleta. " +
                    "Indícame calle y numeración, por ejemplo: " +
                    "Ancud 0103."
            });

            return false;
        }

        estado.direccion = direccion;
        estado.paso = "LISTO_PARA_PEDIR";

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        return true;
    }

    if (estado.paso !== "ESPERANDO_DATOS") {
        return true;
    }

    let datos;

    try {
        datos = await extraerDatosCliente(
            mensaje,
            despachos
        );
    } catch (error) {
        console.error(
            "[Cliente] Error extrayendo datos:",
            error.message
        );

        await sock.sendMessage(currentJid, {
            text:
                "No pude interpretar todos los datos. " +
                "Escríbeme tu nombre, dirección y comuna, " +
                "por ejemplo:\n\n" +
                "*Pablo, Ancud 0103, San Bernardo*"
        });

        return false;
    }

    if (datos.nombre && !estado.nombre) {
        estado.nombre =
            String(datos.nombre).trim();
    }

    if (datos.comuna && !estado.comuna) {
        const despacho =
            buscarDespachoPorComuna(
                despachos,
                datos.comuna
            );

        if (despacho) {
            estado.comuna = despacho.comuna;
            estado.zona = corregirZona(
                despacho.zona
            );
        }
    }

    if (
        datos.direccion &&
        !estado.direccion
    ) {
        estado.direccion =
            String(datos.direccion).trim();
    }

    if (!estado.nombre) {
        estado.paso = "ESPERANDO_DATOS";

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        await sock.sendMessage(currentJid, {
            text:
                "¡Hola! Qué gusto saludarte en " +
                "*Huevos Santa Estela* 🥚\n\n" +
                "¿Podrías indicarme tu *nombre*?"
        });

        return false;
    }

    if (!estado.comuna || !estado.zona) {
        estado.paso = "ESPERANDO_COMUNA";

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        await sock.sendMessage(currentJid, {
            text:
                `Mucho gusto, ${estado.nombre}. ` +
                "¿De qué *comuna* nos escribes?"
        });

        return false;
    }

    if (!estado.direccion) {
        estado.paso = "ESPERANDO_DIRECCION";

        persistirEstadoCliente(
            currentJid,
            telefono,
            estado
        );

        await sock.sendMessage(currentJid, {
            text:
                `Gracias, ${estado.nombre}. ` +
                "¿Cuál es la *dirección de entrega*?"
        });

        return false;
    }

    estado.paso = "LISTO_PARA_PEDIR";

    persistirEstadoCliente(
        currentJid,
        telefono,
        estado
    );

    return true;
}

/* =========================================================
   CONFIRMACIÓN Y CREACIÓN DEL PEDIDO
========================================================= */

async function crearPedidoConMetodoPago({ sock, currentJid, telefono, estado, catalogo, metodoPago }) {
    const pedido = estado.pedidoActual;
    if (!pedido || !Array.isArray(pedido.items) || !pedido.items.length) {
        eliminarPedidoActual(currentJid, telefono, estado);
        await sock.sendMessage(currentJid,{text:"No encontré un pedido pendiente. Indícame los productos y cantidades."});
        return;
    }

    const items = [];
    for (const itemGuardado of pedido.items) {
        const producto = buscarProductoPorId(catalogo,itemGuardado.idProducto);
        if (!producto || !productoDisponibleEnZona(producto,estado.zona)) {
            await sock.sendMessage(currentJid,{text:`${itemGuardado.idProducto} ya no está disponible para tu zona.`});
            return;
        }
        const stock = Number(producto.stockActual ?? 0);
        if (stock < itemGuardado.cantidad) {
            await sock.sendMessage(currentJid,{text:`Solo tenemos ${stock} unidad(es) de ${producto.categoria}.`});
            return;
        }
        const precioUnitario = obtenerPrecioProducto(producto,estado.zona);
        items.push({producto,idProducto:producto.id,cantidad:itemGuardado.cantidad,precioUnitario,subtotal:precioUnitario*itemGuardado.cantidad});
    }

    const total = items.reduce((suma,item)=>suma+item.subtotal,0);
    const idPedido = generarIdPedido();
    estado.paso="GENERANDO_PEDIDO";
    persistirEstadoCliente(currentJid,telefono,estado);

    try {
        let linkPago="";
        let idPreferenciaMP="";
        if (metodoPago === "Mercado Pago") {
            const pago = await crearPreferenciaMercadoPago({idPedido,items,nombreCliente:estado.nombre,telefono});
            if (!pago.linkPago) throw new Error("Mercado Pago no devolvió un link.");
            linkPago=pago.linkPago;
            idPreferenciaMP=pago.preferenceId;
        }

        await guardarPedidoEnSheets({
            idPedido,
            nombreCliente:estado.nombre || "Cliente WhatsApp",
            telefono,
            items:items.map(item=>({idProducto:item.idProducto,cantidad:item.cantidad,precioUnitario:item.precioUnitario,subtotal:item.subtotal})),
            // Compatibilidad con Apps Script anterior
            idProducto:items[0].idProducto,
            cantidad:items[0].cantidad,
            precioUnitario:items[0].precioUnitario,
            total,
            metodoPago,
            estadoPago:"Pendiente",
            estado:"Pendiente",
            comuna:estado.comuna,
            zona:estado.zona,
            direccion:estado.direccion || "Por confirmar",
            linkPago,
            idPreferenciaMP,
            idPagoMP:idPreferenciaMP
        });

        estado.ultimoPedido={idPedido,metodoPago,fecha:new Date().toISOString()};
        if (metodoPago === "Mercado Pago") {
            estado.paso="PAGO_PENDIENTE";
            estado.pedidoActual={items,total,idPedido,metodoPago,linkPago,idPreferenciaMP,estadoPago:"Pendiente"};
        } else {
            estado.paso="LISTO_PARA_PEDIR";
            estado.pedidoActual=null;
        }
        persistirEstadoCliente(currentJid,telefono,estado);

        const detalle=items.map(item=>`• ${item.cantidad} × ${item.producto.categoria}: ${formatearCLP(item.subtotal)}`);
        const respuesta=[`¡Pedido creado correctamente, ${estado.nombre}! 🥚`,"",`Pedido: *${idPedido}*`,...detalle,"",`Total: *${formatearCLP(total)}*`,`Método de pago: *${metodoPago}*`,`Estado de pago: *Pendiente*`,`Estado de despacho: *Pendiente*`];
        if (linkPago) respuesta.push("","🔗 *Link de pago seguro:*",linkPago);
        else respuesta.push("","Pagarás al recibir el pedido.");
        await sock.sendMessage(currentJid,{text:respuesta.join("\n")});
    } catch(error) {
        console.error("[Pedido] Error creando pedido:",error);
        estado.paso="ESPERANDO_METODO_PAGO";
        persistirEstadoCliente(currentJid,telefono,estado);
        await sock.sendMessage(currentJid,{text:"No fue posible crear el pedido. Responde *1* para Mercado Pago o *2* para contra entrega."});
    }
}

/* =========================================================
   PROCESAMIENTO PRINCIPAL DEL MENSAJE
========================================================= */

async function procesarMensaje(sock, msg) {
    if (!msg?.message || msg.key?.fromMe) {
        return;
    }

    const messageId = msg.key.id;

    if (mensajeYaProcesado(messageId)) {
        return;
    }

    const currentJid = msg.key.remoteJid;

    if (
        !currentJid ||
        currentJid === "status@broadcast" ||
        currentJid.endsWith("@g.us")
    ) {
        return;
    }

    const mensaje =
        obtenerTextoMensaje(msg.message);

    if (!mensaje) {
        return;
    }

    if (conversacionesProcesando.has(currentJid)) {
        console.warn(
            `[Conversación] Mensaje omitido temporalmente: ` +
            currentJid
        );

        await sock.sendMessage(currentJid, {
            text:
                "Estoy terminando de procesar tu mensaje " +
                "anterior. Intenta nuevamente en unos segundos."
        });

        return;
    }

    conversacionesProcesando.add(currentJid);

    try {
        const telefono =
            extraerNumeroWhatsApp(msg);

        console.log(
            "========== DIAGNÓSTICO CLIENTE =========="
        );

        console.log({
            remoteJid:
                msg.key.remoteJid,
            remoteJidAlt:
                msg.key.remoteJidAlt || null,
            senderPn:
                msg.key.senderPn || null,
            participant:
                msg.key.participant || null,
            participantAlt:
                msg.key.participantAlt || null,
            telefonoDetectado:
                telefono,
            mensaje
        });

        console.log(
            "========================================="
        );

        const datosSheet =
            await obtenerDatosSheets();

        const catalogo =
            datosSheet.productos || [];

        const clientesMap =
            datosSheet.clientes || {};

        const despachos =
            datosSheet.despachos || [];

        if (!catalogo.length) {
            await sock.sendMessage(currentJid, {
                text:
                    "No puedo consultar el catálogo en este " +
                    "momento. Por favor, intenta nuevamente " +
                    "en unos minutos."
            });

            return;
        }

        /*
         * Si WhatsApp entrega solamente @lid, se mantiene la
         * conversación por JID. La búsqueda por teléfono se hará
         * cuando Baileys entregue remoteJidAlt o senderPn.
         */
        if (!telefono) {
            console.warn(
                "[Identificación] No se encontró teléfono real. " +
                "Se utilizará el JID para conservar la conversación."
            );
        }

        const estado =
            await cargarOCrearEstadoCliente({
                msg,
                currentJid,
                telefono,
                clientesMap,
                despachos
            });

        /*
         * Permite iniciar un pedido nuevo si el anterior sigue
         * registrado como pendiente de pago.
         */
        if (
            estado.paso === "PAGO_PENDIENTE"
        ) {
            const textoNormalizado =
                normalizarTexto(mensaje);

            if (
                textoNormalizado.includes(
                    "nuevo pedido"
                )
            ) {
                eliminarPedidoActual(
                    currentJid,
                    telefono,
                    estado
                );

                await sock.sendMessage(currentJid, {
                    text:
                        "Perfecto. Indícame el producto y " +
                        "la cantidad del nuevo pedido."
                });

                return;
            }

            const link =
                estado.pedidoActual?.linkPago;

            await sock.sendMessage(currentJid, {
                text: [
                    "Ya tienes un pedido pendiente:",
                    "",
                    `Pedido: *${estado.pedidoActual?.idPedido || ""}*`,
                    `Total: *${formatearCLP(
                        estado.pedidoActual?.total || 0
                    )}*`,
                    link
                        ? `Link de pago: ${link}`
                        : "El link de pago está pendiente de revisión.",
                    "",
                    "Si necesitas otro pedido, escribe " +
                    "*nuevo pedido*."
                ].join("\n")
            });

            return;
        }

        if (
            estado.paso === "GENERANDO_PAGO"
        ) {
            await sock.sendMessage(currentJid, {
                text:
                    "Tu pedido se está generando. " +
                    "Espera unos segundos antes de enviar " +
                    "otro mensaje."
            });

            return;
        }

        if (estado.paso === "GENERANDO_PEDIDO") {
            await sock.sendMessage(currentJid,{text:"Tu pedido se está generando. Espera unos segundos."});
            return;
        }

        if (estado.paso === "ESPERANDO_METODO_PAGO") {
            const metodoPago=interpretarMetodoPago(mensaje);
            if (!metodoPago) {
                await sock.sendMessage(currentJid,{text:construirPreguntaMetodoPago(estado)});
                return;
            }
            await crearPedidoConMetodoPago({sock,currentJid,telefono,estado,catalogo,metodoPago});
            return;
        }

        if (estado.paso === "ESPERANDO_CONFIRMACION") {
            if (esRespuestaPositiva(mensaje)) {
                estado.paso="ESPERANDO_METODO_PAGO";
                persistirEstadoCliente(currentJid,telefono,estado);
                await sock.sendMessage(currentJid,{text:construirPreguntaMetodoPago(estado)});
                return;
            }
            if (esRespuestaNegativa(mensaje)) {
                eliminarPedidoActual(currentJid,telefono,estado);
                await sock.sendMessage(currentJid,{text:"Pedido cancelado. No se generó ningún cobro."});
                return;
            }
            await sock.sendMessage(currentJid,{text:"Responde *Sí* para elegir el medio de pago o *No* para cancelar."});
            return;
        }

        const estabaRegistrando =
            estado.paso !== "LISTO_PARA_PEDIR";

        const registroCompleto =
            await procesarRegistroCliente({
                sock,
                currentJid,
                telefono,
                estado,
                mensaje,
                despachos
            });

        if (!registroCompleto) {
            return;
        }

        if (estabaRegistrando) {
            await sock.sendMessage(currentJid, {
                text:
                    construirMensajeCatalogo(
                        estado,
                        catalogo
                    )
            });

            return;
        }

        asignarZonaCliente(
            estado,
            despachos
        );

        if (!estado.zona) {
            estado.paso = "ESPERANDO_COMUNA";

            persistirEstadoCliente(
                currentJid,
                telefono,
                estado
            );

            await sock.sendMessage(currentJid, {
                text:
                    "No pude validar tu comuna en nuestra " +
                    "base de despachos. Escríbeme nuevamente " +
                    "tu comuna."
            });

            return;
        }

        const interpretacion =
            await interpretarPedido(
                mensaje,
                catalogo,
                estado.zona
            );

        if (
            interpretacion.tipo === "cancelar"
        ) {
            eliminarPedidoActual(
                currentJid,
                telefono,
                estado
            );

            await sock.sendMessage(currentJid, {
                text:
                    "No tienes un pedido en confirmación. " +
                    "Puedes comenzar uno indicando producto " +
                    "y cantidad."
            });

            return;
        }

        if (
            interpretacion.tipo ===
            "modificar_datos"
        ) {
            estado.paso = "ESPERANDO_DATOS";
            estado.nombre = null;
            estado.comuna = null;
            estado.direccion = null;
            estado.zona = null;
            estado.pedidoActual = null;

            persistirEstadoCliente(
                currentJid,
                telefono,
                estado
            );

            await sock.sendMessage(currentJid, {
                text:
                    "Perfecto. Envíame nuevamente tu " +
                    "nombre, dirección y comuna.\n\n" +
                    "Ejemplo: *Pablo, Ancud 0103, " +
                    "San Bernardo*"
            });

            return;
        }

        if (
            interpretacion.requiereAclaracion
        ) {
            await sock.sendMessage(currentJid, {
                text:
                    interpretacion.aclaracion ||
                    "Indícame el producto y la cantidad. " +
                    "Por ejemplo: *1 bandeja Jumbo*."
            });

            return;
        }

        if (interpretacion.esPedido && Array.isArray(interpretacion.items) && interpretacion.items.length) {
            const items=[];
            for (const itemInterpretado of interpretacion.items) {
                const producto=buscarProductoPorId(catalogo,itemInterpretado.idProducto);
                const cantidad=Number(itemInterpretado.cantidad);
                if (!producto || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD_PEDIDO) {
                    await sock.sendMessage(currentJid,{text:"No pude identificar todos los productos o cantidades. Ejemplo: *2 Extra y 1 Grande*."});
                    return;
                }
                if (!productoDisponibleEnZona(producto,estado.zona)) {
                    await sock.sendMessage(currentJid,{text:`${producto.categoria} no está disponible para ${estado.zona}.`});
                    return;
                }
                const stock=Number(producto.stockActual ?? 0);
                if (stock < cantidad) {
                    await sock.sendMessage(currentJid,{text:`Tenemos ${stock} unidad(es) de ${producto.categoria}.`});
                    return;
                }
                const precioUnitario=obtenerPrecioProducto(producto,estado.zona);
                items.push({producto,idProducto:producto.id,cantidad,precioUnitario,subtotal:precioUnitario*cantidad});
            }
            const total=items.reduce((suma,item)=>suma+item.subtotal,0);
            estado.pedidoActual={items:items.map(item=>({idProducto:item.idProducto,cantidad:item.cantidad,precioUnitario:item.precioUnitario,subtotal:item.subtotal})),total,creadoEn:new Date().toISOString()};
            estado.paso="ESPERANDO_CONFIRMACION";
            persistirEstadoCliente(currentJid,telefono,estado);
            await sock.sendMessage(currentJid,{text:construirResumenPedido(estado,items)});
            return;
        }

        const respuesta =
            await generarRespuestaConversacional({
                estado,
                mensaje,
                catalogo,
                configuracion:
                    datosSheet.configuracion,
                respuestasFrecuentes:
                    datosSheet.respuestasFrecuentes
            });

        await sock.sendMessage(currentJid, {
            text: respuesta
        });
    } catch (error) {
        console.error(
            "[Mensaje] Error crítico:",
            error
        );

        await sock.sendMessage(currentJid, {
            text:
                "Se produjo un problema procesando tu mensaje. " +
                "Tus datos no fueron eliminados. Intenta " +
                "nuevamente en unos segundos."
        }).catch(() => {});
    } finally {
        conversacionesProcesando.delete(
            currentJid
        );
    }
}

/* =========================================================
   BAILEYS
========================================================= */

let iniciandoBot = false;
let socketActual = null;

async function startBot() {
    if (iniciandoBot) {
        console.log(
            "[WhatsApp] Ya existe un proceso de inicio."
        );

        return;
    }

    iniciandoBot = true;

    try {
        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            "auth_info_baileys"
        );

        const {
            version
        } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: true,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        socketActual = sock;

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        sock.ev.on(
            "connection.update",
            async ({
                connection,
                lastDisconnect,
                qr
            }) => {
                if (qr) {
                    console.log(
                        "[WhatsApp] Escanea el código QR."
                    );
                }

                if (connection === "open") {
                    console.log(
                        "¡Bot de Huevos Santa Estela " +
                        "conectado correctamente!"
                    );

                    iniciandoBot = false;
                }

                if (connection === "close") {
                    iniciandoBot = false;

                    console.error(
                        "[WhatsApp] Conexión cerrada:",
                        lastDisconnect?.error?.message ||
                        lastDisconnect?.error ||
                        "Motivo desconocido"
                    );

                    setTimeout(() => {
                        startBot().catch((error) => {
                            console.error(
                                "[WhatsApp] Error reconectando:",
                                error
                            );
                        });
                    }, TIEMPO_RECONEXION);
                }
            }
        );

        sock.ev.on(
            "messages.upsert",
            async ({
                messages,
                type
            }) => {
                if (type !== "notify") {
                    return;
                }

                /*
                 * Procesamos todos los mensajes recibidos,
                 * no solamente messages[0].
                 */
                for (const msg of messages) {
                    await procesarMensaje(
                        sock,
                        msg
                    );
                }
            }
        );
    } catch (error) {
        iniciandoBot = false;

        console.error(
            "[WhatsApp] Error iniciando bot:",
            error
        );

        setTimeout(() => {
            startBot().catch(console.error);
        }, TIEMPO_RECONEXION);
    }
}

/* =========================================================
   SERVIDOR HTTP
========================================================= */

const server = http.createServer(
    async (req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, {
                "Content-Type":
                    "application/json; charset=utf-8"
            });

            res.end(JSON.stringify({
                status: "ok",
                botConectado:
                    Boolean(socketActual),
                fecha:
                    new Date().toISOString()
            }));

            return;
        }

        res.writeHead(200, {
            "Content-Type":
                "text/plain; charset=utf-8"
        });

        res.end(
            "Bot Huevos Santa Estela activo.\n"
        );
    }
);

server.listen(PORT, () => {
    console.log(
        `Servidor HTTP escuchando en el puerto ${PORT}`
    );

    startBot().catch((error) => {
        console.error(
            "[Inicio] No fue posible iniciar el bot:",
            error
        );
    });
});

/* =========================================================
   CIERRE CONTROLADO
========================================================= */

function cerrarAplicacion(signal) {
    console.log(
        `[Sistema] Señal ${signal}. Guardando memoria.`
    );

    guardarMemoria();

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 5000);
}

process.on(
    "SIGINT",
    () => cerrarAplicacion("SIGINT")
);

process.on(
    "SIGTERM",
    () => cerrarAplicacion("SIGTERM")
);

process.on(
    "uncaughtException",
    (error) => {
        console.error(
            "[Sistema] Excepción no controlada:",
            error
        );

        guardarMemoria();
    }
);

process.on(
    "unhandledRejection",
    (error) => {
        console.error(
            "[Sistema] Promesa rechazada:",
            error
        );

        guardarMemoria();
    }
);
