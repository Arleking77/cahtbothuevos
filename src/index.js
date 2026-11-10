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

function normalizarTextoCompra(valor = "") {
    return normalizarTexto(valor)
        .replace(/\bpromoxion\b/g, "promocion")
        .replace(/\bpromosion\b/g, "promocion")
        .replace(/\bband3jqs\b/g, "bandejas")
        .replace(/\bband3jas\b/g, "bandejas")
        .replace(/\bbanfejas\b/g, "bandejas")
        .replace(/\bbanfeja\b/g, "bandeja")
        .replace(/\b3xtra\b/g, "extra")
        .replace(/\bectra\b/g, "extra")
        .replace(/\bextrra\b/g, "extra")
        .replace(/\s+/g, " ")
        .trim();
}

function esConsultaListaPrecios(texto) {
    const mensaje = normalizarTexto(texto);
    const expresiones = [
        "lista de precios",
        "lista precios",
        "todos los precios",
        "todos los productos",
        "precios de los productos",
        "precios",
        "precio",
        "catalogo",
        "productos disponibles",
        "que productos tienen",
        "que productos hay",
        "cuanto cuestan",
        "valores"
    ];

    return expresiones.some(expresion =>
        mensaje.includes(normalizarTexto(expresion))
    );
}

function construirListaPreciosCompleta(estado, catalogo) {
    const disponibles = catalogo.filter(producto =>
        productoDisponibleEnZona(producto, estado.zona) &&
        obtenerPrecioProducto(producto, estado.zona) > 0
    );

    if (!disponibles.length) {
        return `No encontré productos disponibles para ${estado.zona}.`;
    }

    const secciones = [
        {
            titulo: "*Bandejas individuales*",
            ids: ["PROD-001", "PROD-002", "PROD-003", "PROD-004", "PROD-005"]
        },
        {
            titulo: "*Promociones de 3 bandejas*",
            ids: ["PROD-006", "PROD-007", "PROD-008", "PROD-009"]
        },
        {
            titulo: "*Cajas de 180 huevos*",
            ids: ["PROD-010", "PROD-011", "PROD-012", "PROD-013"]
        }
    ];

    const lineas = [];

    for (const seccion of secciones) {
        const productosSeccion = seccion.ids
            .map(id => disponibles.find(producto => producto.id === id))
            .filter(Boolean);

        if (!productosSeccion.length) continue;

        lineas.push(seccion.titulo);

        productosSeccion.forEach(producto => {
            const precio = obtenerPrecioProducto(producto, estado.zona);
            const nombre = [producto.categoria, producto.descripcion]
                .filter(Boolean)
                .join(" - ");
            const detalles = [producto.gramaje, producto.formato]
                .filter(Boolean)
                .join(" | ");

            lineas.push(
                `• ${nombre}${detalles ? ` | ${detalles}` : ""}: ` +
                `*${formatearCLP(precio)}*`
            );
        });

        lineas.push("");
    }

    return [
        `¡Claro, ${estado.nombre}! 🥚`,
        "",
        `Estos son todos los productos disponibles para *${estado.comuna}*:`,
        "",
        ...lineas,
        "Para realizar un pedido, puedes escribir:",
        "",
        "• *Quiero comprar*",
        "• *Comprar*",
        "• *Nuevo pedido*"
    ].join("\n");
}

function detectarFamiliaProducto(texto) {
    const mensaje = normalizarTextoCompra(texto);

    if (["jumbo", "junbo", "jumvo", "jimbo", "jubo", "especial"].some(x => mensaje.includes(x))) {
        return "jumbo";
    }
    if (["extra grande", "extras", "extra"].some(x => mensaje.includes(x))) {
        return "extra";
    }
    if (["primera", "grandes", "grande"].some(x => mensaje.includes(x))) {
        return "primera";
    }
    if (["segunda", "medianos", "medianas", "mediano", "mediana"].some(x => mensaje.includes(x))) {
        return "segunda";
    }
    if (["tercera", "chicos", "chicas", "chico", "chica", "pequeno", "pequena"].some(x => mensaje.includes(x))) {
        return "tercera";
    }

    return null;
}

function detectarFormatoProducto(texto) {
    const mensaje = normalizarTextoCompra(texto);

    if (
        mensaje.includes("caja 180") ||
        mensaje.includes("caja de 180") ||
        mensaje.includes("caja x 180") ||
        mensaje.includes("180 huevos") ||
        mensaje.includes("180 unidades")
    ) {
        return "caja180";
    }

    if (
        mensaje.includes("3 x") ||
        mensaje.includes("3x") ||
        mensaje.includes("pack 3") ||
        mensaje.includes("pack de 3") ||
        mensaje.includes("promo 3") ||
        mensaje.includes("promocion 3") ||
        mensaje.includes("tres bandejas por")
    ) {
        return "pack3";
    }

    return "individual";
}

function idProductoPorFamiliaYFormato(familia, formato) {
    const mapa = {
        jumbo: {
            individual: "PROD-001"
        },
        extra: {
            individual: "PROD-002",
            pack3: "PROD-006",
            caja180: "PROD-010"
        },
        primera: {
            individual: "PROD-003",
            pack3: "PROD-007",
            caja180: "PROD-011"
        },
        segunda: {
            individual: "PROD-004",
            pack3: "PROD-008",
            caja180: "PROD-012"
        },
        tercera: {
            individual: "PROD-005",
            pack3: "PROD-009",
            caja180: "PROD-013"
        }
    };

    return mapa[familia]?.[formato] || null;
}

function extraerCantidadSegmento(texto, formato) {
    const mensaje = normalizarTextoCompra(texto);

    const palabrasNumero = {
        una: 1,
        un: 1,
        uno: 1,
        dos: 2,
        tres: 3,
        cuatro: 4,
        cinco: 5,
        seis: 6,
        siete: 7,
        ocho: 8,
        nueve: 9,
        diez: 10
    };

    let limpio = mensaje;

    // El 3 de "3 x Extra" describe el formato, no la cantidad pedida.
    if (formato === "pack3") {
        limpio = limpio
            .replace(/\b3\s*x\b/g, " ")
            .replace(/\b3x\b/g, " ")
            .replace(/\bpack\s*(?:de\s*)?3\b/g, " ")
            .replace(/\bpromo(?:cion)?\s*3\b/g, " ");
    }

    // El 180 describe el contenido de la caja, no la cantidad de cajas.
    if (formato === "caja180") {
        limpio = limpio.replace(/\b180\b/g, " ");
    }

    const numero = limpio.match(/\b(\d{1,3})\b/);
    if (numero) {
        const cantidad = Number.parseInt(numero[1], 10);
        return cantidad >= 1 && cantidad <= MAX_CANTIDAD_PEDIDO
            ? cantidad
            : null;
    }

    for (const [palabra, cantidad] of Object.entries(palabrasNumero)) {
        if (new RegExp(`\\b${palabra}\\b`).test(limpio)) {
            return cantidad;
        }
    }

    return 1;
}

function dividirSolicitudEnSegmentos(texto) {
    return normalizarTextoCompra(texto)
        .replace(/\s+y\s+/g, "|")
        .replace(/\s*,\s*/g, "|")
        .replace(/\s*;\s*/g, "|")
        .split("|")
        .map(segmento => segmento.trim())
        .filter(Boolean);
}

function extraerItemsLocales(catalogo, texto) {
    const segmentos = dividirSolicitudEnSegmentos(texto);
    const acumulados = new Map();

    for (const segmento of segmentos) {
        const familia = detectarFamiliaProducto(segmento);
        if (!familia) continue;

        const formato = detectarFormatoProducto(segmento);
        const idProducto = idProductoPorFamiliaYFormato(familia, formato);
        if (!idProducto) continue;

        const producto = catalogo.find(item => item.id === idProducto);
        if (!producto) continue;

        const cantidad = extraerCantidadSegmento(segmento, formato);
        if (!cantidad) continue;

        acumulados.set(
            idProducto,
            (acumulados.get(idProducto) || 0) + cantidad
        );
    }

    return Array.from(acumulados.entries()).map(
        ([idProducto, cantidad]) => ({
            idProducto,
            cantidad
        })
    );
}

async function interpretarPedido(mensaje, catalogo, zona) {
    const itemsLocales = extraerItemsLocales(catalogo, mensaje);

    if (itemsLocales.length) {
        return {
            tipo: "pedido",
            esPedido: true,
            items: itemsLocales,
            requiereAclaracion: false,
            aclaracion: null
        };
    }

    const modelo = genAI.getGenerativeModel({
        model: MODELO_GEMINI
    });

    const prompt = `
Clasifica el mensaje para Huevos Santa Estela y extrae TODOS los productos solicitados.

Mensaje:
"${mensaje}"

Catálogo oficial:
${construirCatalogoTexto(catalogo, zona)}

Reglas obligatorias:
1. Usa exclusivamente IDs presentes en el catálogo.
2. Distingue estos formatos:
   - Bandeja individual Extra = PROD-002.
   - Pack 3 x Extra = PROD-006.
   - Caja 180 Extra = PROD-010.
   - Pack 3 x Primera = PROD-007.
   - Caja 180 Primera = PROD-011.
   - Pack 3 x Segunda = PROD-008.
   - Caja 180 Segunda = PROD-012.
   - Pack 3 x Tercera = PROD-009.
   - Caja 180 Tercera = PROD-013.
3. Reconoce errores como jimbo, junbo y banfeja.
4. Una consulta de precios no es un pedido.
5. Si el cliente pide varios productos, devuelve todos en items.
6. Devuelve únicamente JSON válido, sin markdown.

Formato:
{
  "tipo": "consulta",
  "esPedido": false,
  "items": [],
  "requiereAclaracion": false,
  "aclaracion": null
}
`;

    const resultado = await modelo.generateContent(prompt);
    const salida = parsearJSONSeguro(
        resultado.response.text(),
        {
            tipo: "consulta",
            esPedido: false,
            items: [],
            requiereAclaracion: false,
            aclaracion: null
        }
    );

    if (!Array.isArray(salida.items)) {
        salida.items = [];
    }

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

function esConsultaVendedores(texto) {
    const mensaje = normalizarTextoCompra(texto);
    const expresiones = [
        "contacto vendedor",
        "contacto de vendedor",
        "contacto de los vendedores",
        "hablar con vendedor",
        "hablar con un vendedor",
        "hablar con alguien",
        "numero de ventas",
        "telefono de ventas",
        "ejecutivo",
        "vendedor"
    ];
    return expresiones.some(expresion => mensaje.includes(expresion));
}

function construirMensajeVendedores(vendedores) {
    if (!Array.isArray(vendedores) || !vendedores.length) {
        return [
            "No encontré contactos de vendedores configurados en este momento.",
            "Puedes escribir *ayuda* para volver al menú principal."
        ].join("\n");
    }

    const lineas = vendedores.map(vendedor => {
        const telefono = normalizarTelefono(vendedor.telefono || "");
        return [
            `• *${vendedor.nombre || "Vendedor"}*`,
            vendedor.rol ? `  ${vendedor.rol}` : null,
            telefono ? `  📱 +${telefono}` : null,
            vendedor.horario ? `  🕐 ${vendedor.horario}` : null
        ].filter(Boolean).join("\n");
    });

    return [
        "👨‍💼 *Contactos de Huevos Santa Estela*",
        "",
        ...lineas,
        "",
        "Puedes escribir directamente al número indicado."
    ].join("\n");
}

function esConsultaEstadoPedido(texto) {
    const mensaje = normalizarTextoCompra(texto);
    const expresiones = [
        "estado de mi pedido",
        "estado pedido",
        "mi pedido",
        "seguimiento",
        "donde esta mi pedido",
        "donde viene mi pedido",
        "cuando llega mi pedido",
        "como va mi pedido"
    ];
    return expresiones.some(expresion => mensaje.includes(expresion));
}

function fechaPedidoNumero(pedido) {
    const fecha = new Date(pedido?.fecha || 0);
    return Number.isNaN(fecha.getTime()) ? 0 : fecha.getTime();
}

function obtenerUltimoPedidoCliente(pedidos, telefono) {
    const buscado = normalizarTelefono(telefono || "");
    if (!buscado || !Array.isArray(pedidos)) return null;

    return pedidos
        .filter(pedido => normalizarTelefono(pedido.telefono || "") === buscado)
        .sort((a, b) => fechaPedidoNumero(b) - fechaPedidoNumero(a))[0] || null;
}

function descripcionEstadoDespacho(estado) {
    const valor = normalizarTextoCompra(estado);
    const mensajes = {
        pendiente: "🟡 Tu pedido está pendiente de preparación.",
        "en preparacion": "🟠 Tu pedido está siendo preparado.",
        "en camino": "🚚 Tu pedido va en camino.",
        entregado: "✅ Tu pedido figura como entregado.",
        cancelado: "❌ Tu pedido figura como cancelado."
    };
    return mensajes[valor] || `🚚 Estado de despacho: ${estado || "Sin información"}`;
}

function construirEstadoPedido(pedido, catalogo) {
    if (!pedido) {
        return [
            "No encontré pedidos asociados a tu número de WhatsApp.",
            "Si necesitas ayuda, escribe *vendedor*."
        ].join("\n");
    }

    const detalles = Array.isArray(pedido.detalles) && pedido.detalles.length
        ? pedido.detalles
        : [{
            idProducto: pedido.idProducto,
            cantidad: pedido.cantidad,
            subtotal: pedido.total
        }];

    const productos = detalles.map(detalle => {
        const producto = catalogo.find(item => item.id === detalle.idProducto);
        const nombre = producto
            ? `${producto.categoria} - ${producto.descripcion || ""}`
            : detalle.idProducto;
        return `• ${detalle.cantidad} × ${nombre}`;
    });

    return [
        "📦 *Estado de tu pedido*",
        "",
        `Pedido: *${pedido.idPedido}*`,
        "",
        "🥚 *Productos:*",
        ...productos,
        "",
        `💰 Total: *${formatearCLP(pedido.total)}*`,
        `💳 Pago: *${pedido.estadoPago || "Pendiente"}*`,
        `🚚 Despacho: *${pedido.estado || "Pendiente"}*`,
        descripcionEstadoDespacho(pedido.estado),
        "",
        `📍 ${pedido.direccion || "Dirección por confirmar"}`
    ].join("\n");
}

function esSolicitudAyuda(texto) {
    const mensaje = normalizarTextoCompra(texto);
    return ["ayuda", "menu", "opciones", "que puedes hacer"].includes(mensaje);
}

function construirMenuPrincipal(nombre) {
    return [
        `🥚 *Huevos Santa Estela${nombre ? ` - ${nombre}` : ""}*`,
        "",
        "¿Qué necesitas?",
        "",
        "1️⃣ Comprar",
        "2️⃣ Ver lista de precios",
        "3️⃣ Consultar mi pedido",
        "4️⃣ Hablar con un vendedor",
        "",
        "Responde con un número o escribe tu consulta."
    ].join("\n");
}

function esSolicitudMenuCompra(texto) {
    const mensaje = normalizarTextoCompra(texto);
    const comandos = [
        "comprar",
        "nuevo pedido",
        "hacer pedido",
        "quiero comprar",
        "iniciar pedido",
        "menu de compra",
        "menu compra"
    ];

    return comandos.some(comando => mensaje === comando || mensaje.includes(comando));
}

function opcionesFormato() {
    return [
        "🥚 *¿Qué formato deseas?*",
        "",
        "1️⃣ Bandejas individuales",
        "2️⃣ Promociones de 3 bandejas",
        "3️⃣ Cajas de 180 huevos",
        "",
        "Responde *1*, *2* o *3*.",
        "También puedes escribir *cancelar*."
    ].join("\n");
}

function productosPorFormato(formato) {
    const mapa = {
        individual: ["PROD-001", "PROD-002", "PROD-003", "PROD-004", "PROD-005"],
        pack3: ["PROD-006", "PROD-007", "PROD-008", "PROD-009"],
        caja180: ["PROD-010", "PROD-011", "PROD-012", "PROD-013"]
    };
    return mapa[formato] || [];
}

function construirMenuProductos(formato, catalogo, zona) {
    const titulos = {
        individual: "*Bandejas individuales*",
        pack3: "*Promociones de 3 bandejas*",
        caja180: "*Cajas de 180 huevos*"
    };

    const ids = productosPorFormato(formato);
    const productos = ids
        .map(id => catalogo.find(producto => producto.id === id))
        .filter(producto => producto && productoDisponibleEnZona(producto, zona));

    const lineas = productos.map((producto, indice) =>
        `${indice + 1}️⃣ ${producto.categoria} - ${producto.descripcion || ""}: ` +
        `*${formatearCLP(obtenerPrecioProducto(producto, zona))}*`
    );

    return [
        titulos[formato] || "*Productos*",
        "",
        ...lineas,
        "",
        "Responde con el número del producto.",
        "Escribe *volver* para cambiar de formato o *cancelar*."
    ].join("\n");
}

function numeroSeleccion(texto) {
    const mensaje = normalizarTextoCompra(texto);
    const match = mensaje.match(/^([1-9]|10)$/);
    return match ? Number.parseInt(match[1], 10) : null;
}

function construirCarrito(estado, catalogo) {
    const items = estado.pedidoActual?.items || [];
    const lineas = items.map(item => {
        const producto = catalogo.find(p => p.id === item.idProducto);
        return `• ${item.cantidad} × ${producto?.categoria || item.idProducto}: ` +
            `${formatearCLP(item.subtotal)}`;
    });
    const total = items.reduce((suma, item) => suma + Number(item.subtotal || 0), 0);

    return [
        "🛒 *Tu carrito*",
        "",
        ...lineas,
        "",
        `*Total: ${formatearCLP(total)}*`,
        `📍 ${estado.direccion || "Por confirmar"}, ${estado.comuna}`,
        "",
        "1️⃣ Confirmar pedido",
        "2️⃣ Agregar otro producto",
        "3️⃣ Vaciar y comenzar de nuevo",
        "4️⃣ Cancelar"
    ].join("\n");
}

function iniciarMenuCompra(currentJid, telefono, estado) {
    estado.paso = "MENU_FORMATO";
    estado.menuFormato = null;
    estado.seleccionTemporal = null;
    estado.pedidoActual = {
        items: [],
        total: 0,
        creadoEn: new Date().toISOString()
    };
    persistirEstadoCliente(currentJid, telefono, estado);
}

function agregarItemCarrito(estado, producto, cantidad) {
    const precioUnitario = obtenerPrecioProducto(producto, estado.zona);
    const items = estado.pedidoActual?.items || [];
    const existente = items.find(item => item.idProducto === producto.id);

    if (existente) {
        existente.cantidad += cantidad;
        existente.precioUnitario = precioUnitario;
        existente.subtotal = existente.cantidad * precioUnitario;
    } else {
        items.push({
            idProducto: producto.id,
            cantidad,
            precioUnitario,
            subtotal: precioUnitario * cantidad
        });
    }

    estado.pedidoActual.items = items;
    estado.pedidoActual.total = items.reduce(
        (suma, item) => suma + Number(item.subtotal || 0),
        0
    );
}

function detectarAmbiguedadTresUnidades(texto) {
    const mensaje = normalizarTextoCompra(texto);
    const familia = detectarFamiliaProducto(mensaje);

    if (!familia || familia === "jumbo") return null;
    if (detectarFormatoProducto(mensaje) !== "individual") return null;

    const tieneTres = /\b3\b/.test(mensaje) || /\btres\b/.test(mensaje);
    const explicitaIndividual = mensaje.includes("individual") || mensaje.includes("sueltas");

    if (!tieneTres || explicitaIndividual) return null;

    return familia;
}

function construirPreguntaAmbiguedad(familia, catalogo, zona) {
    const idIndividual = idProductoPorFamiliaYFormato(familia, "individual");
    const idPromo = idProductoPorFamiliaYFormato(familia, "pack3");
    const individual = catalogo.find(p => p.id === idIndividual);
    const promo = catalogo.find(p => p.id === idPromo);

    if (!individual || !promo) return null;

    const totalIndividual = obtenerPrecioProducto(individual, zona) * 3;
    const totalPromo = obtenerPrecioProducto(promo, zona);

    return [
        "Encontré dos posibilidades:",
        "",
        `1️⃣ 3 bandejas ${individual.descripcion || individual.categoria} individuales: ` +
        `*${formatearCLP(totalIndividual)}*`,
        `2️⃣ 1 promoción ${promo.categoria}: *${formatearCLP(totalPromo)}*`,
        "",
        "¿Cuál deseas? Responde *1* o *2*."
    ].join("\n");
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

        const clienteExistenteSheet = Boolean(
            buscarClienteEnSheets(
                clientesMap,
                telefono
            )
        );

        const estado =
            await cargarOCrearEstadoCliente({
                msg,
                currentJid,
                telefono,
                clientesMap,
                despachos
            });

        const clienteConRegistroCompleto = Boolean(
            clienteExistenteSheet &&
            estado.nombre &&
            estado.comuna &&
            estado.zona &&
            estado.direccion &&
            estado.paso === "LISTO_PARA_PEDIR"
        );

        const comandoGlobal = normalizarTextoCompra(mensaje);

        if (clienteConRegistroCompleto && esSolicitudAyuda(mensaje)) {
            await sock.sendMessage(currentJid, {
                text: construirMenuPrincipal(estado.nombre)
            });
            return;
        }

        if (clienteConRegistroCompleto && comandoGlobal === "1") {
            iniciarMenuCompra(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, { text: opcionesFormato() });
            return;
        }

        if (clienteConRegistroCompleto && comandoGlobal === "2") {
            await sock.sendMessage(currentJid, {
                text: construirListaPreciosCompleta(estado, catalogo)
            });
            return;
        }

        if (
            clienteConRegistroCompleto &&
            (comandoGlobal === "3" || esConsultaEstadoPedido(mensaje))
        ) {
            const ultimoPedido = obtenerUltimoPedidoCliente(
                datosSheet.pedidos || [],
                telefono
            );
            await sock.sendMessage(currentJid, {
                text: construirEstadoPedido(ultimoPedido, catalogo)
            });
            return;
        }

        if (
            clienteConRegistroCompleto &&
            (comandoGlobal === "4" || esConsultaVendedores(mensaje))
        ) {
            await sock.sendMessage(currentJid, {
                text: construirMensajeVendedores(datosSheet.vendedores || [])
            });
            return;
        }

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
                iniciarMenuCompra(
                    currentJid,
                    telefono,
                    estado
                );

                await sock.sendMessage(currentJid, {
                    text: opcionesFormato()
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

        if (estado.paso === "MENU_FORMATO") {
            const opcion = numeroSeleccion(mensaje);
            const formatos = { 1: "individual", 2: "pack3", 3: "caja180" };

            if (normalizarTextoCompra(mensaje).includes("cancelar")) {
                eliminarPedidoActual(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, { text: "Pedido cancelado." });
                return;
            }

            if (!formatos[opcion]) {
                await sock.sendMessage(currentJid, { text: opcionesFormato() });
                return;
            }

            estado.menuFormato = formatos[opcion];
            estado.paso = "MENU_PRODUCTO";
            persistirEstadoCliente(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, {
                text: construirMenuProductos(estado.menuFormato, catalogo, estado.zona)
            });
            return;
        }

        if (estado.paso === "MENU_PRODUCTO") {
            const textoMenu = normalizarTextoCompra(mensaje);

            if (textoMenu.includes("volver")) {
                estado.paso = "MENU_FORMATO";
                persistirEstadoCliente(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, { text: opcionesFormato() });
                return;
            }

            if (textoMenu.includes("cancelar")) {
                eliminarPedidoActual(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, { text: "Pedido cancelado." });
                return;
            }

            const opcion = numeroSeleccion(mensaje);
            const ids = productosPorFormato(estado.menuFormato);
            const idProducto = opcion ? ids[opcion - 1] : null;
            const producto = catalogo.find(p => p.id === idProducto);

            if (!producto || !productoDisponibleEnZona(producto, estado.zona)) {
                await sock.sendMessage(currentJid, {
                    text: construirMenuProductos(estado.menuFormato, catalogo, estado.zona)
                });
                return;
            }

            estado.seleccionTemporal = { idProducto: producto.id };
            estado.paso = "MENU_CANTIDAD";
            persistirEstadoCliente(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, {
                text: [
                    `Seleccionaste *${producto.categoria} - ${producto.descripcion || ""}*`,
                    `Precio: *${formatearCLP(obtenerPrecioProducto(producto, estado.zona))}*`,
                    "",
                    "¿Cuántas unidades de este producto deseas?",
                    "Responde con un número entre 1 y 100."
                ].join("\n")
            });
            return;
        }

        if (estado.paso === "MENU_CANTIDAD") {
            const cantidad = Number.parseInt(normalizarTextoCompra(mensaje), 10);
            const producto = catalogo.find(
                p => p.id === estado.seleccionTemporal?.idProducto
            );

            if (!producto || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD_PEDIDO) {
                await sock.sendMessage(currentJid, {
                    text: `Indica una cantidad válida entre 1 y ${MAX_CANTIDAD_PEDIDO}.`
                });
                return;
            }

            const stock = Number(producto.stockActual ?? 0);
            if (stock < cantidad) {
                await sock.sendMessage(currentJid, {
                    text: `Solo tenemos ${stock} unidad(es) de ${producto.categoria}.`
                });
                return;
            }

            agregarItemCarrito(estado, producto, cantidad);
            estado.seleccionTemporal = null;
            estado.paso = "MENU_CARRITO";
            persistirEstadoCliente(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, {
                text: construirCarrito(estado, catalogo)
            });
            return;
        }

        if (estado.paso === "MENU_CARRITO") {
            const opcion = numeroSeleccion(mensaje);

            if (opcion === 1) {
                estado.paso = "ESPERANDO_METODO_PAGO";
                persistirEstadoCliente(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, {
                    text: construirPreguntaMetodoPago(estado)
                });
                return;
            }

            if (opcion === 2) {
                estado.paso = "MENU_FORMATO";
                persistirEstadoCliente(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, { text: opcionesFormato() });
                return;
            }

            if (opcion === 3) {
                iniciarMenuCompra(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, { text: opcionesFormato() });
                return;
            }

            if (opcion === 4) {
                eliminarPedidoActual(currentJid, telefono, estado);
                await sock.sendMessage(currentJid, { text: "Pedido cancelado." });
                return;
            }

            await sock.sendMessage(currentJid, {
                text: construirCarrito(estado, catalogo)
            });
            return;
        }

        if (estado.paso === "MENU_AMBIGUEDAD") {
            const opcion = numeroSeleccion(mensaje);
            const familia = estado.ambiguedadFamilia;
            const formato = opcion === 1 ? "individual" : opcion === 2 ? "pack3" : null;

            if (!formato) {
                await sock.sendMessage(currentJid, {
                    text: construirPreguntaAmbiguedad(familia, catalogo, estado.zona)
                });
                return;
            }

            const idProducto = idProductoPorFamiliaYFormato(familia, formato);
            const producto = catalogo.find(p => p.id === idProducto);
            const cantidad = formato === "individual" ? 3 : 1;

            estado.pedidoActual = {
                items: [],
                total: 0,
                creadoEn: new Date().toISOString()
            };
            agregarItemCarrito(estado, producto, cantidad);
            estado.ambiguedadFamilia = null;
            estado.paso = "MENU_CARRITO";
            persistirEstadoCliente(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, {
                text: construirCarrito(estado, catalogo)
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
            // Cualquier descripción de producto reemplaza el pedido pendiente.
            const nuevaInterpretacion = await interpretarPedido(
                mensaje,
                catalogo,
                estado.zona
            );

            if (nuevaInterpretacion.esPedido && Array.isArray(nuevaInterpretacion.items) && nuevaInterpretacion.items.length) {
                const nuevosItems = [];

                for (const item of nuevaInterpretacion.items) {
                    const producto = buscarProductoPorId(catalogo, item.idProducto);
                    const cantidad = Number(item.cantidad);
                    if (!producto || !Number.isInteger(cantidad) || cantidad < 1) continue;
                    const precioUnitario = obtenerPrecioProducto(producto, estado.zona);
                    nuevosItems.push({
                        producto,
                        idProducto: producto.id,
                        cantidad,
                        precioUnitario,
                        subtotal: precioUnitario * cantidad
                    });
                }

                if (nuevosItems.length) {
                    estado.pedidoActual = {
                        items: nuevosItems.map(item => ({
                            idProducto: item.idProducto,
                            cantidad: item.cantidad,
                            precioUnitario: item.precioUnitario,
                            subtotal: item.subtotal
                        })),
                        total: nuevosItems.reduce((suma, item) => suma + item.subtotal, 0),
                        creadoEn: new Date().toISOString()
                    };
                    persistirEstadoCliente(currentJid, telefono, estado);
                    await sock.sendMessage(currentJid, {
                        text: construirResumenPedido(estado, nuevosItems)
                    });
                    return;
                }
            }

            await sock.sendMessage(currentJid, {
                text: "Responde *Sí* para elegir el medio de pago, *No* para cancelar o escribe *menú* para elegir productos."
            });
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

        if (
            clienteConRegistroCompleto &&
            (esSolicitudMenuCompra(mensaje) || normalizarTextoCompra(mensaje) === "menu")
        ) {
            iniciarMenuCompra(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, { text: opcionesFormato() });
            return;
        }

        const familiaAmbigua = clienteConRegistroCompleto
            ? detectarAmbiguedadTresUnidades(mensaje)
            : null;
        if (familiaAmbigua) {
            estado.paso = "MENU_AMBIGUEDAD";
            estado.ambiguedadFamilia = familiaAmbigua;
            persistirEstadoCliente(currentJid, telefono, estado);
            await sock.sendMessage(currentJid, {
                text: construirPreguntaAmbiguedad(
                    familiaAmbigua,
                    catalogo,
                    estado.zona
                )
            });
            return;
        }

        if (clienteConRegistroCompleto && esConsultaListaPrecios(mensaje)) {
            console.log(
                `[Catálogo] Enviando ${catalogo.length} productos para ${estado.zona}.`
            );

            await sock.sendMessage(currentJid, {
                text: construirListaPreciosCompleta(
                    estado,
                    catalogo
                )
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
