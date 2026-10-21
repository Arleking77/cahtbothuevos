import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function probar() {
    try {
        console.log("Probando la API...");
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent("Hola, responde 'OK'");
        console.log("¡ÉXITO TOTAL! Respuesta de Gemini:", result.response.text());
    } catch (error) {
        console.error("Error exacto:", error.message);
    }
}

probar();