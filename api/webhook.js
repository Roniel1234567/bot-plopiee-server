import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(req, res) {
  // 1. VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // 2. RECEPCIÓN DE MENSAJES (POST)
  if (req.method === 'POST') {
    const body = req.body;
    console.log("Datos recibidos:", JSON.stringify(body, null, 2)); // ESTO ES PARA VER SI LLEGA ALGO

    if (body.object === 'instagram') {
      try {
        for (const entry of body.entry) {
          // Ajuste para detectar el mensaje correctamente
          const messagingEvent = entry.messaging ? entry.messaging[0] : (entry.changes ? entry.changes[0].value.messages[0] : null);
          
          if (messagingEvent && messagingEvent.message && !messagingEvent.message.is_echo) {
            const senderId = messagingEvent.sender.id;
            const userMessage = messagingEvent.message.text;

            const botResponse = await generarRespuestaGemini(userMessage);
            await enviarMensajeInstagram(senderId, botResponse);
          }
        }
        return res.status(200).send('EVENT_RECEIVED');
      } catch (error) {
        console.error('Error:', error);
        return res.status(500).send('Error');
      }
    }
    return res.status(404).send('Not Found');
  }
}

// Tus funciones originales se quedan igual, solo asegúrate de que estén dentro del archivo
async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash', // Cambiado a 1.5 para asegurar compatibilidad
      contents: mensajeUsuario,
      config: { systemInstruction: "Eres el asistente virtual amable y profesional de Plopiee." }
    });
    return response.text;
  } catch (error) { return "Lo siento, tengo problemas técnicos."; }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.INSTAGRAM_TOKEN}`;
  await axios.post(url, { recipient: { id: recipientId }, message: { text: texto } });
}
