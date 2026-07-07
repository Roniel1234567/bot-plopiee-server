import express from 'express';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(express.json());

// Inicializamos el SDK de Gemini usando la API Key de las variables de entorno
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. VALIDACIÓN DEL WEBHOOK (Esto lo pide Meta en el "Paso 3")
app.get('/api/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook verificado correctamente.');
            return res.status(200).send(challenge);
        } else {
            return res.status(403).sendStatus(403);
        }
    }
});

// 2. RECEPCIÓN DE MENSAJES DE INSTAGRAM
app.post('/api/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'instagram') {
        try {
            for (const entry of body.entry) {
                if (entry.messaging) {
                    const messagingEvent = entry.messaging[0];
                    const senderId = messagingEvent.sender.id; // ID de Instagram del cliente

                    // Verificar que sea un mensaje de texto y que no sea un eco de nuestro propio bot
                    if (messagingEvent.message && messagingEvent.message.text && !messagingEvent.message.is_echo) {
                        const userMessage = messagingEvent.message.text;
                        console.log(`Mensaje recibido de ${senderId}: ${userMessage}`);

                        // Generar la respuesta usando la IA de Gemini
                        const botResponse = await generarRespuestaGemini(userMessage);

                        // Enviar la respuesta de vuelta al cliente en Instagram
                        await enviarMensajeInstagram(senderId, botResponse);
                    }
                }
            }
            return res.status(200).send('EVENT_RECEIVED');
        } catch (error) {
            console.error('Error procesando el webhook:', error);
            return res.status(500).send('ERROR');
        }
    } else {
        return res.sendStatus(404);
    }
});

// FUNCIÓN PARA GENERAR RESPUESTA CON GEMINI
async function generarRespuestaGemini(mensajeUsuario) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: mensajeUsuario,
            config: {
                // Aquí configuras las instrucciones del sistema y la personalidad de tu bot
                systemInstruction: "Eres el asistente virtual amable y profesional de Plopiee. Responde de forma concisa, servicial y amigable.",
            }
        });
        return response.text;
    } catch (error) {
        console.error('Error con la API de Gemini:', error);
        return "Lo siento, tuve un pequeño inconveniente técnico. ¿Me lo podrías repetir?";
    }
}

// FUNCIÓN PARA ENVIAR EL MENSAJE POR LA API DE INSTAGRAM
async function enviarMensajeInstagram(recipientId, texto) {
    const PAGE_ACCESS_TOKEN = process.env.INSTAGRAM_TOKEN; // El token largo de p_lopiee
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const payload = {
        recipient: { id: recipientId },
        message: { text: texto }
    };

    await axios.post(url, payload);
    console.log(`Mensaje enviado con éxito a ${recipientId}`);
}

export default app;
