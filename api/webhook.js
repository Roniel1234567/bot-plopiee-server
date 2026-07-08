import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inicialización de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    
    // Prueba forzada para diagnóstico
    if (req.query.test === 'true') {
      try {
        const respuesta = await generarRespuestaGemini("Hola, dime si funcionas");
        return res.status(200).send("Gemini respondió: " + respuesta);
      } catch (e) {
        return res.status(500).send("Error en Gemini: " + e.message);
      }
    }

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
      const messaging = req.body.entry?.[0]?.messaging?.[0];
      
      if (messaging?.message?.text && messaging.sender?.id) {
        const botResponse = await generarRespuestaGemini(messaging.message.text);
        await enviarMensajeInstagram(messaging.sender.id, botResponse);
      }
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR EN POST:', error.message);
      return res.status(200).send('EVENT_RECEIVED');
    }
  }

  return res.status(405).send('Method Not Allowed');
}

async function generarRespuestaGemini(texto) {
  try {
    // Usamos el modelo estándar
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(texto);
    return result.response.text();
  } catch (error) {
    return "Error técnico: " + error.message;
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
    console.error("Error al enviar a Instagram:", error.response?.data?.error?.message || error.message);
  }
}
