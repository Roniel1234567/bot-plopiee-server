import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

// Inicialización corregida
const ai = new GoogleGenAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log("Intento de verificación. Token recibido:", token);

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // 2. RECEPCIÓN DE MENSAJES (POST)
  if (req.method === 'POST') {
    try {
      const body = req.body;
      
      // Meta envía los mensajes en entry[0].messaging[0]
      const entry = body.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (messaging && messaging.message && !messaging.message.is_echo) {
        const senderId = messaging.sender.id;
        const userMessage = messaging.message.text;

        const botResponse = await generarRespuestaGemini(userMessage);
        await enviarMensajeInstagram(senderId, botResponse);
      }
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('Error procesando POST:', error);
      return res.status(500).send('Internal Server Error');
    }
  }
}

async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(mensajeUsuario);
    return result.response.text();
  } catch (error) {
    console.error("Error Gemini:", error);
    return "Lo siento, tuve un error al procesar tu mensaje.";
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.INSTAGRAM_TOKEN}`;
  await axios.post(url, { recipient: { id: recipientId }, message: { text: texto } });
}
