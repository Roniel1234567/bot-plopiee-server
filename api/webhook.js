import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inicialización de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    
    // --- PRUEBA FORZADA (Diagnóstico) ---
    if (req.query.test === 'true') {
      try {
        const respuesta = await generarRespuestaGemini("Hola, dime si funcionas");
        return res.status(200).send("Gemini respondió: " + respuesta);
      } catch (e) {
        return res.status(500).send("Error en Gemini: " + e.message);
      }
    }
    // ------------------------------------

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
    try {
      const { entry } = req.body;
      if (entry?.[0]?.messaging?.[0]) {
        const messaging = entry[0].messaging[0];
        const senderId = messaging.sender?.id;
        const userMessage = messaging.message?.text;

        if (userMessage && senderId) {
          const botResponse = await generarRespuestaGemini(userMessage);
          await enviarMensajeInstagram(senderId, botResponse);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR DETALLADO:', error.stack);
      return res.status(500).send('Error');
    }
  }
}

async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(mensajeUsuario);
    return result.response.text();
  } catch (error) {
    console.error("Error Gemini:", error.message);
    return "Error al procesar con IA.";
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.facebook.com/v21.0/me/messages`;
  try {
    await axios.post(url, 
      { recipient: { id: recipientId }, message: { text: texto } },
      { params: { access_token: process.env.INSTAGRAM_TOKEN } }
    );
  } catch (error) {
    console.error("Error Facebook:", error.response?.data?.error?.message);
  }
}
