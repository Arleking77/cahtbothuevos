import 'dotenv/config';

async function listarYProbar() {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log("Consultando modelos disponibles en Google AI...");

    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();

        if (data.error) {
            console.error("Error en la API Key:", data.error.message);
            return;
        }

        console.log("\n--- MODELOS DISPONIBLES EN TU CUENTA ---");
        const modelosValidos = data.models
            ? data.models.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            : [];

        modelosValidos.forEach(m => console.log(`- ${m.name.replace('models/', '')}`));

        if (modelosValidos.length === 0) {
            console.log("No se encontraron modelos con soporte para generateContent.");
            return;
        }

        const modeloElegido = modelosValidos[0].name.replace('models/', '');
        console.log(`\nProbando automáticamente con el primer modelo disponible: ${modeloElegido}...`);

        const resTest = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modeloElegido}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Hola, responde 'OK'" }] }]
            })
        });

        const dataTest = await resTest.json();
        const respuesta = dataTest.candidates?.[0]?.content?.parts?.[0]?.text;

        if (respuesta) {
            console.log("\n¡ÉXITO TOTAL! Respuesta recibida:", respuesta.trim());
            console.log(`==> El nombre exacto que debes usar en tu bot es: "${modeloElegido}"`);
        } else {
            console.log("Error al generar contenido:", JSON.stringify(dataTest, null, 2));
        }

    } catch (e) {
        console.error("Error de conexión:", e.message);
    }
}

listarYProbar();